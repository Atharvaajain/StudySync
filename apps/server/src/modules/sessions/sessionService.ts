/**
 * Session engine: the imperative shell around the pure timer machine (ARCHITECTURE §13.10).
 *
 * Every operation on a user's session runs in ONE database transaction:
 *   pg_advisory_xact_lock(user) → SELECT active session FOR UPDATE → reconcile (apply a due
 *   auto-save, stamped at its deadline) → decide() / decideSystem() → write rows + event.
 * Only after COMMIT: update the in-process view cache, publish domain events and reschedule
 * the deadline triggers. The server clock is the only source of time (R14).
 *
 * Deadlines are data (§13.5): the scheduler, the sweeper, the next command and the next read
 * all apply the same `dueAutoSave`, so the outcome is identical whether it runs on time, late,
 * or after a restart. One user's disconnect or break never touches another user's session (R1).
 *
 * Callers run every method of one user on the per-user queue (KeyedQueue), so operations are
 * also ordered in-process (§13.8). The view cache exists for synchronous room-status pushes;
 * the database is the source of truth and every operation re-reads it under the lock.
 */
import {
  HISTORY_PAGE_MAX,
  LEASE_STALE_MS,
  decide,
  decideSystem,
  nextAutoSave,
  phaseOf,
  type AutoSavedNotice,
  type Phase,
  type SessionCause,
  type SessionCore,
  type SessionDto,
  type SessionHistoryPage,
  type SessionStatePayload,
  type SessionSummaryDto,
  type SystemEvent,
  type TimerCommand,
  type TimerEventType,
} from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { lockUser, transaction, type Db, type Tx } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { Logger } from '../../lib/logger';
import type { DeadlineScheduler } from '../../lib/scheduler';
import { toIso, toIsoOrNull } from '../../lib/time';
import {
  applyTransition,
  findCommand,
  isTaskAttachable,
  latestUnseenAutoSave,
  loadActiveView,
  markSummarySeen,
  sessionHistory,
  sessionSummary,
  tryLockUser,
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
  /**
   * §11.3 (D-7): is the user live for a session in `roomId` on this instance? Solo (`null`):
   * any socket on any page. Room: present in that room.
   */
  isLive: (userId: string, roomId: string | null) => boolean;
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
  DISCONNECTED: 'DISCONNECTED',
  LEASE_LOST: 'DISCONNECTED',
  RECONNECTED: 'RECONNECTED',
  GRACE_EXPIRED: 'AUTO_SAVED_DISCONNECT',
  IDLE_TIMEOUT: 'AUTO_SAVED_IDLE',
};

const breakOverKey = (userId: string): string => `break-over:${userId}`;
const autoSaveKey = (userId: string): string => `auto-save:${userId}`;

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

/** A transition committed inside a user transaction, published after COMMIT. */
interface Applied {
  type: TimerEventType;
  roomId: string | null;
  sessionId: string;
}

interface TxContext {
  tx: Tx;
  view: SessionView | null;
  now: number;
  /** Apply a transition and record it for publishing; returns the session view afterwards. */
  apply(
    t: Omit<Parameters<typeof applyTransition>[1], 'userId'>,
    roomId: string | null,
  ): Promise<SessionView | null>;
}

const SKIPPED = Symbol('skipped');

export class SessionService {
  /** userId → the ACTIVE session as last committed (null = none). */
  private readonly views = new Map<string, SessionView | null>();
  /** userId → the unseen system-ended session (the "session saved" notice), if any. */
  private readonly notices = new Map<string, AutoSavedNotice | null>();

  constructor(private readonly deps: SessionServiceDeps) {}

  // ───────────── user commands ─────────────

  /** Apply one user command. Throws AppError (with `details.session`) on rejection. */
  async execute(
    userId: string,
    presence: PresenceContext,
    input: CommandInput,
  ): Promise<CommandResult> {
    const outcome = await this.inUserTx(userId, async ({ tx, view, now, apply }) => {
      // C3: a replayed commandId returns the current outcome without re-applying.
      const prior = await findCommand(tx, userId, input.commandId);
      if (prior) {
        if (prior.type !== EVENT_FOR_COMMAND[input.type]) {
          return {
            kind: 'rejected' as const,
            error: this.rejection(userId, 'VALIDATION_ERROR', { reason: 'commandId already used' }),
          };
        }
        return { kind: 'replayed' as const, sessionId: prior.sessionId };
      }

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
        return { kind: 'rejected' as const, error: this.rejection(userId, result.code, extra) };
      }

      // I-17: only your own personal task or a task of the session's room can be attached.
      const taskId = result.next?.taskId ?? null;
      const taskChanged = (input.type === 'START' || input.type === 'SET_TASK') && taskId !== null;
      if (
        taskChanged &&
        !(await isTaskAttachable(tx, userId, taskId, result.next?.roomId ?? null))
      ) {
        return { kind: 'rejected' as const, error: this.rejection(userId, 'TASK_NOT_ATTACHABLE') };
      }

      const sessionId = result.next?.id ?? core!.id;
      await apply(
        {
          core,
          next: result.next,
          effects: result.effects,
          event: result.event,
          commandId: input.commandId,
        },
        result.next?.roomId ?? core?.roomId ?? null,
      );
      return { kind: 'applied' as const, sessionId };
    });
    if (outcome === SKIPPED) throw new Error('unreachable: commands always wait for the lock');

    if (outcome.kind === 'rejected') throw outcome.error;
    return {
      session: this.activeSessionDto(userId),
      summary: input.type === 'END' ? await this.summaryFor(userId, outcome.sessionId) : null,
      replayed: outcome.kind === 'replayed',
    };
  }

  /**
   * Called when the user enters `roomId` (join_room). A solo session moves into the room
   * (row 11) without resetting; a session that lives in another room blocks the entry (row 19).
   */
  async enterRoom(userId: string, roomId: string): Promise<{ moved: boolean }> {
    const outcome = await this.inUserTx(userId, async ({ view, now, apply }) => {
      const core = view?.core ?? null;
      if (!core || core.roomId === roomId) return { moved: false };
      const result = decide(
        core,
        { type: 'MOVE_TO_ROOM', roomId },
        { now, newSessionId: '', userPresenceRoomId: null, callerRoomId: null },
      );
      if (!result.ok) {
        return {
          moved: false,
          error: this.rejection(userId, result.code, { roomName: view?.roomName ?? null }),
        };
      }
      await apply(
        { core, next: result.next, effects: result.effects, event: result.event, commandId: null },
        roomId,
      );
      return { moved: true };
    });
    if (outcome === SKIPPED) throw new Error('unreachable');
    if ('error' in outcome && outcome.error) throw outcome.error;
    return { moved: outcome.moved };
  }

  // ───────────── liveness, deadlines, sweeper (§11.3, §13.5–§13.9) ─────────────

  /**
   * Re-evaluate liveness after a connect, disconnect, join, leave, start or move. Live → not
   * live sets `disconnected_at = now` (row 8); back in time clears it (row 9). The phase never
   * changes, and nobody else's session is involved (R1).
   */
  async evaluateLiveness(userId: string): Promise<void> {
    const cached = this.views.get(userId);
    if (cached === null) return; // known: no active session
    if (cached !== undefined) {
      const live = this.deps.isLive(userId, cached.core.roomId);
      const inGrace = (cached.core.disconnectedAt ?? null) !== null;
      if (live !== inGrace) return; // consistent: nothing to do
    }
    await this.inUserTx(userId, async ({ view, now, apply }) => {
      if (!view) return;
      const live = this.deps.isLive(userId, view.core.roomId);
      const event: SystemEvent = live
        ? { type: 'LIVENESS_REGAINED', at: now }
        : { type: 'LIVENESS_LOST', at: now, cause: 'DISCONNECTED' };
      const result = decideSystem(view.core, event);
      if (!result.ok) return;
      await apply(
        {
          core: view.core,
          next: result.next,
          effects: result.effects,
          event: result.event,
          commandId: null,
        },
        view.core.roomId,
      );
    });
  }

  /** Apply a due auto-save, if any (scheduler trigger and every read). */
  async reconcile(userId: string): Promise<void> {
    await this.inUserTx(userId, async () => undefined);
  }

  /**
   * One sweeper step for a candidate user (§6.7). Never waits for a busy user
   * (`pg_try_advisory_xact_lock`). A stale lease means liveness was lost at `last_seen_at`
   * (crash path, §13.6) — unless the user is live on this instance right now.
   */
  async sweep(userId: string): Promise<'skipped' | 'done'> {
    const outcome = await this.inUserTx(
      userId,
      async ({ view, now, apply }) => {
        if (!view || (view.core.disconnectedAt ?? null) !== null) return;
        if (view.lastSeenAt >= now - LEASE_STALE_MS) return;
        if (this.deps.isLive(userId, view.core.roomId)) return; // the lease refresh catches up
        const result = decideSystem(view.core, {
          type: 'LIVENESS_LOST',
          at: view.lastSeenAt,
          cause: 'LEASE_LOST',
        });
        if (!result.ok) return;
        const after = await apply(
          {
            core: view.core,
            next: result.next,
            effects: result.effects,
            event: result.event,
            commandId: null,
          },
          view.core.roomId,
        );
        // The grace deadline is anchored at last_seen_at and may already have passed.
        const due = decideSystem(after?.core ?? null, { type: 'AUTO_SAVE', now });
        if (due.ok && after) {
          await apply(
            {
              core: after.core,
              next: null,
              effects: due.effects,
              event: due.event,
              commandId: null,
            },
            after.core.roomId,
          );
        }
      },
      { tryLock: true },
    );
    return outcome === SKIPPED ? 'skipped' : 'done';
  }

  /**
   * Reloads the user's ACTIVE session (reconciled) into the view cache, with the unseen
   * auto-save notice. Called on socket connect and by REST reads (F-32).
   */
  async refresh(userId: string): Promise<SessionDto | null> {
    await this.inUserTx(userId, async () => undefined);
    this.notices.set(userId, await latestUnseenAutoSave(this.deps.db, userId));
    return this.activeSessionDto(userId);
  }

  /** POST /sessions/:id/summary-seen (owner only, idempotent). */
  async markSummarySeen(userId: string, sessionId: string): Promise<void> {
    const found = await markSummarySeen(this.deps.db, userId, sessionId, this.deps.clock.now());
    if (!found) throw new AppError('NOT_FOUND');
    this.notices.set(userId, await latestUnseenAutoSave(this.deps.db, userId));
  }

  // ───────────── reads ─────────────

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
      disconnectedAt: toIsoOrNull(core.disconnectedAt ?? null),
      autoSaveAt: toIsoOrNull(nextAutoSave(core)?.at ?? null),
    };
  }

  statePayload(userId: string, cause: SessionCause): SessionStatePayload {
    return {
      session: this.activeSessionDto(userId),
      cause,
      lastAutoSaved: this.notices.get(userId) ?? null,
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

  /** The room the user's active session lives in (from the committed view), or null. */
  sessionRoomOf(userId: string): string | null {
    return this.views.get(userId)?.core.roomId ?? null;
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

  /**
   * The per-user transaction: lock, load, reconcile, then `body`. Everything applied is
   * published after COMMIT. With `tryLock`, returns SKIPPED if a command holds the lock.
   */
  private async inUserTx<T>(
    userId: string,
    body: (ctx: TxContext) => Promise<T>,
    options: { tryLock?: boolean } = {},
  ): Promise<T | typeof SKIPPED> {
    const { db, clock } = this.deps;
    const applied: Applied[] = [];
    let finalView: SessionView | null | undefined;
    let value: T | typeof SKIPPED;
    try {
      value = await transaction(db, async (tx) => {
        if (options.tryLock) {
          if (!(await tryLockUser(tx, userId))) return SKIPPED;
        } else {
          await lockUser(tx, userId);
        }
        const now = clock.now();
        let view = await loadActiveView(tx, userId, { forUpdate: true });

        const apply: TxContext['apply'] = async (t, roomId) => {
          const sessionId = await applyTransition(tx, { userId, ...t });
          applied.push({ type: t.event.type, roomId, sessionId });
          view = await loadActiveView(tx, userId, { forUpdate: false });
          return view;
        };

        // Reconcile first (§13.5): a due auto-save is applied, stamped at its deadline.
        const due = decideSystem(view?.core ?? null, { type: 'AUTO_SAVE', now });
        if (due.ok && view) {
          await apply(
            {
              core: view.core,
              next: null,
              effects: due.effects,
              event: due.event,
              commandId: null,
            },
            view.core.roomId,
          );
        }
        // Rejections computed in `body` carry the current session (API_DESIGN §3).
        this.views.set(userId, view);
        const result = await body({ tx, view, now, apply });
        finalView = view;
        return result;
      });
    } catch (error) {
      // Nothing was committed: re-read the committed state so the cache stays truthful.
      this.views.set(userId, await loadActiveView(db, userId, { forUpdate: false }));
      throw error;
    }
    if (value === SKIPPED) return SKIPPED;

    // ── after commit ──
    this.views.set(userId, finalView ?? null);
    this.rescheduleDeadlines(userId, finalView?.core ?? null);
    for (const a of applied) {
      if (a.type === 'GRACE_EXPIRED' || a.type === 'IDLE_TIMEOUT') {
        this.notices.set(userId, await latestUnseenAutoSave(db, userId));
      }
      this.publishChange(userId, CAUSE_FOR_EVENT[a.type], a.roomId);
      this.deps.logger.info({ userId, sessionId: a.sessionId, event: a.type }, 'timer transition');
    }
    return value;
  }

  /**
   * Triggers for the deadlines (§13.5): the break-over push at `ends_at` (row 3, no write) and
   * the next auto-save (grace or idle). The sweeper is the restart-safe backstop.
   */
  private rescheduleDeadlines(userId: string, core: SessionCore | null): void {
    const { scheduler, queue, clock } = this.deps;
    const now = clock.now();
    const brk = core?.currentBreak ?? null;
    if (core && core.currentSegmentStartedAt === null && brk && brk.endsAt > now) {
      const sessionId = core.id;
      const endsAt = brk.endsAt;
      scheduler.schedule(breakOverKey(userId), endsAt, () => {
        void queue.run(userId, () => this.handleBreakOver(userId, sessionId, endsAt));
      });
    } else {
      scheduler.cancel(breakOverKey(userId));
    }
    const next = core ? nextAutoSave(core) : null;
    if (next) {
      scheduler.schedule(autoSaveKey(userId), next.at, () => {
        void queue
          .run(userId, () => this.reconcile(userId))
          .catch((err: unknown) => this.deps.logger.error({ err, userId }, 'auto-save failed'));
      });
    } else {
      scheduler.cancel(autoSaveKey(userId));
    }
  }

  private handleBreakOver(userId: string, sessionId: string, endsAt: number): void {
    const core = this.views.get(userId)?.core ?? null;
    // Only if the same break is still current (the user may have ended the session).
    if (!core || core.id !== sessionId || core.currentBreak?.endsAt !== endsAt) return;
    if (phaseOf(core, this.deps.clock.now()) !== 'BREAK_OVER') {
      this.rescheduleDeadlines(userId, core);
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
