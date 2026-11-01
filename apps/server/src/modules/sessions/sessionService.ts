/**
 * Session engine: the imperative shell around the pure timer machine (ARCHITECTURE §13.10).
 *
 * For every command, in ONE database transaction:
 *   pg_advisory_xact_lock(user) → SELECT active session FOR UPDATE → commandId replay check →
 *   decide() (pure, `now` from the injected Clock) → write segments / breaks / session / event.
 * Only after COMMIT: update the in-process view cache, publish domain events and (re)schedule
 * the break-over push. The server clock is the only source of time (R14).
 *
 * Callers run every method of one user on the per-user queue (KeyedQueue), so commands are
 * also ordered in-process (§13.8). The view cache exists for synchronous room-status pushes;
 * the database is the source of truth and every command re-reads it under the lock.
 */
import {
  HISTORY_PAGE_MAX,
  decide,
  phaseOf,
  type Phase,
  type SessionCause,
  type SessionCore,
  type SessionDto,
  type SessionHistoryPage,
  type SessionStatePayload,
  type SessionSummaryDto,
  type TimerCommand,
  type TimerEventType,
} from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { lockUser, transaction, type Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { Logger } from '../../lib/logger';
import type { DeadlineScheduler } from '../../lib/scheduler';
import { toIso, toIsoOrNull } from '../../lib/time';
import {
  applyTransition,
  findCommand,
  isTaskAttachable,
  loadActiveView,
  sessionHistory,
  sessionSummary,
  type SessionView,
} from './sessionRepository';

export type CommandInput =
  | { type: 'START'; commandId: string; roomId: string | null; taskId?: string | null | undefined }
  | { type: 'TAKE_BREAK'; commandId: string; sessionId: string; durationMinutes: number }
  | { type: 'RESUME'; commandId: string; sessionId: string }
  | { type: 'END'; commandId: string; sessionId: string }
  | { type: 'SET_TASK'; commandId: string; sessionId: string; taskId: string | null };

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
  db: Db;
  clock: Clock;
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
  SET_TASK: 'TASK_SET',
};

const CAUSE_FOR_EVENT: Record<TimerEventType, SessionCause> = {
  STARTED: 'START',
  BREAK_TAKEN: 'BREAK',
  RESUMED: 'RESUME',
  ENDED: 'END',
  MOVED_TO_ROOM: 'MOVED_TO_ROOM',
  TASK_SET: 'TASK_SET',
};

const breakOverKey = (userId: string): string => `break-over:${userId}`;

/** Opaque keyset cursor for GET /sessions. */
const encodeCursor = (startedAt: string, id: string): string =>
  Buffer.from(`${startedAt}|${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const [startedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = startedAt ? new Date(startedAt) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError('VALIDATION_ERROR', { reason: 'invalid cursor' });
  }
  return { startedAt: date, id };
}

export class SessionService {
  /** userId → the ACTIVE session as last committed (null = none). */
  private readonly views = new Map<string, SessionView | null>();

  constructor(private readonly deps: SessionServiceDeps) {}

  /** Apply one user command. Throws AppError (with `details.session`) on rejection. */
  async execute(
    userId: string,
    presence: PresenceContext,
    input: CommandInput,
  ): Promise<CommandResult> {
    const { db, clock } = this.deps;

    const outcome = await transaction(db, async (tx) => {
      await lockUser(tx, userId);
      const view = await loadActiveView(tx, userId, { forUpdate: true });
      this.views.set(userId, view);

      // C3: a replayed commandId returns the current outcome without re-applying.
      const prior = await findCommand(tx, userId, input.commandId);
      if (prior) {
        if (prior.type !== EVENT_FOR_COMMAND[input.type]) {
          throw this.rejection(userId, 'VALIDATION_ERROR', { reason: 'commandId already used' });
        }
        return { kind: 'replayed' as const, sessionId: prior.sessionId };
      }

      const now = clock.now();
      const core = view?.core ?? null;
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

      // I-17: only your own personal task or a task of the session's room can be attached.
      const taskId = result.next?.taskId ?? null;
      const taskChanged = (input.type === 'START' || input.type === 'SET_TASK') && taskId !== null;
      if (
        taskChanged &&
        !(await isTaskAttachable(tx, userId, taskId, result.next?.roomId ?? null))
      ) {
        throw this.rejection(userId, 'TASK_NOT_ATTACHABLE');
      }

      const sessionId = await applyTransition(tx, {
        userId,
        core,
        next: result.next,
        effects: result.effects,
        event: result.event,
        commandId: input.commandId,
      });
      const after = await loadActiveView(tx, userId, { forUpdate: false });
      return {
        kind: 'applied' as const,
        sessionId,
        after,
        event: result.event,
        roomId: result.next?.roomId ?? core?.roomId ?? null,
      };
    });

    if (outcome.kind === 'replayed') {
      return {
        session: this.activeSessionDto(userId),
        summary: input.type === 'END' ? await this.summaryFor(userId, outcome.sessionId) : null,
        replayed: true,
      };
    }

    // ── after commit ──
    this.views.set(userId, outcome.after);
    this.rescheduleBreakOver(userId, outcome.after?.core ?? null);
    this.publishChange(userId, CAUSE_FOR_EVENT[outcome.event.type], outcome.roomId);
    this.deps.logger.info(
      {
        userId,
        sessionId: outcome.sessionId,
        event: outcome.event.type,
        from: outcome.event.fromPhase,
        to: outcome.event.toPhase,
      },
      'timer transition',
    );

    return {
      session: this.activeSessionDto(userId),
      summary: input.type === 'END' ? await this.summaryFor(userId, outcome.sessionId) : null,
      replayed: false,
    };
  }

  /**
   * Called when the user enters `roomId` (join_room). A solo session moves into the room
   * (row 11); a session that lives in another room blocks the entry (row 19).
   */
  async enterRoom(userId: string, roomId: string): Promise<{ moved: boolean }> {
    const { db, clock } = this.deps;
    const outcome = await transaction(db, async (tx) => {
      await lockUser(tx, userId);
      const view = await loadActiveView(tx, userId, { forUpdate: true });
      this.views.set(userId, view);
      const core = view?.core ?? null;
      if (!core || core.roomId === roomId) return null;
      const result = decide(
        core,
        { type: 'MOVE_TO_ROOM', roomId },
        { now: clock.now(), newSessionId: '', userPresenceRoomId: null, callerRoomId: null },
      );
      if (!result.ok) {
        throw this.rejection(userId, result.code, { roomName: view?.roomName ?? null });
      }
      await applyTransition(tx, {
        userId,
        core,
        next: result.next,
        effects: result.effects,
        event: result.event,
        commandId: null,
      });
      return loadActiveView(tx, userId, { forUpdate: false });
    });
    if (outcome === null) return { moved: false };
    this.views.set(userId, outcome);
    this.rescheduleBreakOver(userId, outcome?.core ?? null);
    this.publishChange(userId, 'MOVED_TO_ROOM', roomId);
    return { moved: true };
  }

  /**
   * Reloads the user's ACTIVE session from the database into the view cache. Called on socket
   * connect and by REST reads, so every (re)connect sees the committed state (F-32).
   */
  async refresh(userId: string): Promise<SessionDto | null> {
    const view = await loadActiveView(this.deps.db, userId, { forUpdate: false });
    this.views.set(userId, view);
    this.rescheduleBreakOver(userId, view?.core ?? null);
    return this.activeSessionDto(userId);
  }

  /** The caller's own active session as a wire DTO, from the committed view. */
  activeSessionDto(userId: string): SessionDto | null {
    const view = this.views.get(userId);
    if (!view) return null;
    const { core } = view;
    return {
      id: core.id,
      phase: phaseOf(core, this.deps.clock.now()) as Phase,
      version: core.version,
      roomId: core.roomId,
      roomName: view.roomName,
      task: view.task,
      startedAt: toIso(core.startedAt),
      studyMsClosed: view.studyMsClosed,
      currentSegmentStartedAt: toIsoOrNull(core.currentSegmentStartedAt),
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
    const core = this.views.get(userId)?.core;
    if (!core || core.roomId !== roomId) return null;
    return {
      phase: phaseOf(core, this.deps.clock.now()) as Phase,
      breakEndsAt: core.currentBreak?.endsAt ?? null,
    };
  }

  /** End-of-session summary (F-39, DATABASE_DESIGN §6.4). Owner only, else NOT_FOUND. */
  async summaryFor(userId: string, sessionId: string): Promise<SessionSummaryDto> {
    const summary = await sessionSummary(this.deps.db, userId, sessionId, this.deps.clock.now());
    if (!summary) throw new AppError('NOT_FOUND');
    return summary;
  }

  /** Session history, newest first (§6.10). */
  async history(
    userId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<SessionHistoryPage> {
    const limit = Math.min(query.limit ?? 20, HISTORY_PAGE_MAX);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const items = await sessionHistory(
      this.deps.db,
      userId,
      after,
      limit + 1,
      this.deps.clock.now(),
    );
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: items.length > limit && last ? encodeCursor(last.startedAt, last.id) : null,
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
    if (brk.endsAt <= this.deps.clock.now()) {
      this.deps.scheduler.cancel(key); // already over: clients derive BREAK_OVER themselves
      return;
    }
    const sessionId = next.id;
    const endsAt = brk.endsAt;
    this.deps.scheduler.schedule(key, endsAt, () => {
      void this.deps.queue.run(userId, () => this.handleBreakOver(userId, sessionId, endsAt));
    });
  }

  private handleBreakOver(userId: string, sessionId: string, endsAt: number): void {
    const core = this.views.get(userId)?.core ?? null;
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
        return { type: 'START', roomId: input.roomId, taskId: input.taskId ?? null };
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
      case 'SET_TASK':
        return { type: 'SET_TASK', sessionId: input.sessionId, taskId: input.taskId };
    }
  }
}
