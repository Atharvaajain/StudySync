/**
 * Session engine: the imperative shell around the pure timer machine (ARCHITECTURE §13.10).
 *
 * For every command: idempotency check → decide() (pure) → store.apply() (validated, atomic)
 * → only then publish domain events and (re)schedule the break-over push.
 * The server clock is the only source of time (R14); clients never send instants or durations.
 *
 * All methods are synchronous. Callers run them on the per-user queue (KeyedQueue), so the
 * commands of one user are applied strictly in order (§13.8).
 */
import {
  decide,
  phaseOf,
  type Phase,
  type SessionCause,
  type SessionCore,
  type SessionDto,
  type SessionStatePayload,
  type SessionSummaryDto,
  type TimerCommand,
  type TimerEventType,
} from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { Logger } from '../../lib/logger';
import type { DeadlineScheduler } from '../../lib/scheduler';
import { toIso, toIsoOrNull } from '../../lib/time';
import type { RoomRegistry } from '../rooms/roomRegistry';
import type { InMemorySessionStore } from './sessionStore';

export type CommandInput =
  | { type: 'START'; commandId: string; roomId: string | null; taskId?: string | null | undefined }
  | { type: 'TAKE_BREAK'; commandId: string; sessionId: string; durationMinutes: number }
  | { type: 'RESUME'; commandId: string; sessionId: string }
  | { type: 'END'; commandId: string; sessionId: string };

/** Where the user and the calling socket are (liveness rules, ARCHITECTURE §11.3). */
export interface PresenceContext {
  userPresenceRoomId: string | null;
  callerRoomId: string | null;
}

export interface CommandResult {
  session: SessionDto | null;
  summary: SessionSummaryDto | null;
  replayed: boolean;
}

export interface SessionServiceDeps {
  store: InMemorySessionStore;
  clock: Clock;
  rooms: RoomRegistry;
  scheduler: DeadlineScheduler;
  events: DomainEvents;
  queue: KeyedQueue;
  newId: () => string;
  logger: Logger;
}

const EVENT_FOR_COMMAND: Record<CommandInput['type'], TimerEventType> = {
  START: 'STARTED',
  TAKE_BREAK: 'BREAK_TAKEN',
  RESUME: 'RESUMED',
  END: 'ENDED',
};

const CAUSE_FOR_EVENT: Record<TimerEventType, SessionCause> = {
  STARTED: 'START',
  BREAK_TAKEN: 'BREAK',
  RESUMED: 'RESUME',
  ENDED: 'END',
  MOVED_TO_ROOM: 'MOVED_TO_ROOM',
};

const breakOverKey = (userId: string): string => `break-over:${userId}`;

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /** Apply one user command. Throws AppError (with `details.session`) on rejection. */
  execute(userId: string, presence: PresenceContext, input: CommandInput): CommandResult {
    const { store, clock } = this.deps;

    // C3: a replayed commandId returns the current outcome without re-applying.
    const prior = store.findCommand(userId, input.commandId);
    if (prior) {
      if (prior.type !== EVENT_FOR_COMMAND[input.type]) {
        throw this.rejection(userId, 'VALIDATION_ERROR', { reason: 'commandId already used' });
      }
      return {
        session: this.activeSessionDto(userId),
        summary: input.type === 'END' ? this.summary(prior.sessionId) : null,
        replayed: true,
      };
    }

    // Tasks arrive in Phase 1: no task can be attached yet (I-17).
    if (input.type === 'START' && input.taskId != null) {
      throw this.rejection(userId, 'TASK_NOT_ATTACHABLE');
    }

    const now = clock.now();
    const core = store.activeCore(userId);
    const result = decide(core, this.toCommand(input), {
      now,
      newSessionId: this.deps.newId(),
      userPresenceRoomId: presence.userPresenceRoomId,
      callerRoomId: presence.callerRoomId,
    });
    if (!result.ok) {
      const extra = result.details?.breakEndsAt
        ? { breakEndsAt: toIso(result.details.breakEndsAt) }
        : undefined;
      throw this.rejection(userId, result.code, extra);
    }

    const sessionId = result.next?.id ?? core!.id;
    store.apply({
      userId,
      sessionId,
      next: result.next,
      effects: result.effects,
      event: result.event,
      commandId: input.commandId,
    });

    // ── after commit ──
    this.rescheduleBreakOver(userId, result.next);
    this.publishChange(
      userId,
      CAUSE_FOR_EVENT[result.event.type],
      result.next?.roomId ?? core?.roomId ?? null,
    );
    this.deps.logger.info(
      {
        userId,
        sessionId,
        event: result.event.type,
        from: result.event.fromPhase,
        to: result.event.toPhase,
      },
      'timer transition',
    );

    return {
      session: this.activeSessionDto(userId),
      summary: input.type === 'END' ? this.summary(sessionId) : null,
      replayed: false,
    };
  }

  /**
   * Called when the user enters `roomId` (join_room). A solo session moves into the room
   * (row 11); a session that lives in another room blocks the entry (row 19).
   */
  enterRoom(userId: string, roomId: string): { moved: boolean } {
    const core = this.deps.store.activeCore(userId);
    if (!core || core.roomId === roomId) return { moved: false };
    const result = decide(
      core,
      { type: 'MOVE_TO_ROOM', roomId },
      {
        now: this.deps.clock.now(),
        newSessionId: '',
        userPresenceRoomId: null,
        callerRoomId: null,
      },
    );
    if (!result.ok) {
      const roomName = core.roomId ? (this.deps.rooms.get(core.roomId)?.name ?? null) : null;
      throw this.rejection(userId, result.code, { roomName });
    }
    this.deps.store.apply({
      userId,
      sessionId: core.id,
      next: result.next,
      effects: result.effects,
      event: result.event,
      commandId: null,
    });
    this.rescheduleBreakOver(userId, result.next);
    this.publishChange(userId, 'MOVED_TO_ROOM', roomId);
    return { moved: true };
  }

  /** The caller's own active session as a wire DTO (refresh-proof reconstruction, F-32). */
  activeSessionDto(userId: string): SessionDto | null {
    const { store, clock, rooms } = this.deps;
    const row = store.activeSessionRow(userId);
    const core = store.activeCore(userId);
    if (!row || !core) return null;
    const studyMsClosed = store
      .segmentsOf(row.id)
      .reduce((sum, g) => (g.endedAt === null ? sum : sum + (g.endedAt - g.startedAt)), 0);
    return {
      id: row.id,
      phase: phaseOf(core, clock.now()) as Phase,
      version: row.version,
      roomId: row.roomId,
      roomName: row.roomId ? (rooms.get(row.roomId)?.name ?? null) : null,
      task: null,
      startedAt: toIso(row.startedAt),
      studyMsClosed,
      currentSegmentStartedAt: toIsoOrNull(row.currentSegmentStartedAt),
      break: core.currentBreak
        ? {
            durationMinutes: core.currentBreak.durationMinutes,
            startedAt: toIso(core.currentBreak.startedAt),
            endsAt: toIso(core.currentBreak.endsAt),
          }
        : null,
      // Disconnect grace and idle auto-save arrive in Phase 2.
      disconnectedAt: null,
      autoSaveAt: null,
    };
  }

  statePayload(userId: string, cause: SessionCause): SessionStatePayload {
    return {
      session: this.activeSessionDto(userId),
      cause,
      lastAutoSaved: null,
      serverNow: toIso(this.deps.clock.now()),
    };
  }

  /** What the room should show for this user's timer (null = no session in this room). */
  roomView(userId: string, roomId: string): { phase: Phase; breakEndsAt: number | null } | null {
    const core = this.deps.store.activeCore(userId);
    if (!core || core.roomId !== roomId) return null;
    return {
      phase: phaseOf(core, this.deps.clock.now()) as Phase,
      breakEndsAt: core.currentBreak?.endsAt ?? null,
    };
  }

  /** End-of-session summary, computed from segments and breaks (F-39, I-12). */
  summary(sessionId: string): SessionSummaryDto {
    const { store, clock, rooms } = this.deps;
    const row = store.getSession(sessionId);
    if (!row) throw new AppError('NOT_FOUND');
    const now = clock.now();
    const segments = store.segmentsOf(sessionId);
    const breaks = store.breaksOf(sessionId);
    const studiedMs = segments.reduce((sum, g) => sum + ((g.endedAt ?? now) - g.startedAt), 0);
    const breakMs = breaks.reduce(
      (sum, b) => sum + (Math.min(b.closedAt ?? now, b.endsAt) - b.startedAt),
      0,
    );
    return {
      id: row.id,
      startedAt: toIso(row.startedAt),
      endedAt: toIsoOrNull(row.endedAt),
      endReason: row.endReason,
      studiedMs,
      breaks: { count: breaks.length, totalMs: breakMs },
      where: {
        roomId: row.roomId,
        roomName: row.roomId ? (rooms.get(row.roomId)?.name ?? null) : null,
        movedFromSolo: row.roomId !== null && segments.some((g) => g.roomId === null),
      },
      task: null,
      completedTasks: [],
    };
  }

  // ───────────── internals ─────────────

  /** Push at the instant the break countdown ends (row 3). No write: the phase is derived. */
  private rescheduleBreakOver(userId: string, next: SessionCore | null): void {
    const key = breakOverKey(userId);
    const brk = next?.currentBreak ?? null;
    if (!next || next.currentSegmentStartedAt !== null || brk === null) {
      this.deps.scheduler.cancel(key);
      return;
    }
    const sessionId = next.id;
    const endsAt = brk.endsAt;
    this.deps.scheduler.schedule(key, endsAt, () => {
      void this.deps.queue.run(userId, () => this.handleBreakOver(userId, sessionId, endsAt));
    });
  }

  private handleBreakOver(userId: string, sessionId: string, endsAt: number): void {
    const core = this.deps.store.activeCore(userId);
    // Only if the same break is still current (the user may have ended the session).
    if (!core || core.id !== sessionId || core.currentBreak?.endsAt !== endsAt) return;
    if (phaseOf(core, this.deps.clock.now()) !== 'BREAK_OVER') {
      this.rescheduleBreakOver(userId, core);
      return;
    }
    // R5: the timer does NOT resume. We only tell the user and the room that the break is over.
    this.publishChange(userId, 'BREAK_OVER', core.roomId);
  }

  private publishChange(userId: string, cause: SessionCause, roomId: string | null): void {
    this.deps.events.publish({ type: 'session_changed', userId, cause });
    if (roomId) this.deps.events.publish({ type: 'member_status_changed', roomId, userId });
  }

  private rejection(
    userId: string,
    code: ConstructorParameters<typeof AppError>[0],
    extra?: Record<string, unknown>,
  ): AppError {
    return new AppError(code, { session: this.activeSessionDto(userId), ...extra });
  }

  private toCommand(input: CommandInput): TimerCommand {
    switch (input.type) {
      case 'START':
        return { type: 'START', roomId: input.roomId };
      case 'TAKE_BREAK':
        return {
          type: 'TAKE_BREAK',
          sessionId: input.sessionId,
          durationMinutes: input.durationMinutes,
        };
      case 'RESUME':
        return { type: 'RESUME', sessionId: input.sessionId };
      case 'END':
        return { type: 'END', sessionId: input.sessionId };
    }
  }
}
