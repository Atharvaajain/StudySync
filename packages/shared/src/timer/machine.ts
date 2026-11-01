/**
 * The pure study-timer state machine (ARCHITECTURE §13).
 *
 * - No I/O, no clock access: `now` is always passed in (CLAUDE.md architecture rules).
 * - Phases are derived, never stored: STUDYING iff a segment is open; otherwise ON_BREAK until
 *   the break's `endsAt`, then BREAK_OVER (§13.2).
 * - System events can never enter STUDYING; only `start_study` / `resume_study` (user) can (R5).
 *
 * User commands: transition-table rows 1–6 and 11–21 (`decide`). System events — liveness lost
 * or regained and the idle / disconnect auto-saves (rows 7–10) — live in `./system.ts`.
 */
import { isBreakMinutes, minutesToMs, type BreakMinutes } from '../constants';
import type { Phase } from '../dto';
import type { TimerRejectionCode } from '../errors';

export type PhaseOrNone = Phase | 'NO_SESSION';

/** Epoch milliseconds (UTC instant). */
export type EpochMs = number;

export interface BreakCore {
  readonly durationMinutes: BreakMinutes;
  readonly startedAt: EpochMs;
  readonly endsAt: EpochMs;
}

/** The authoritative state of ONE user's ACTIVE session. Every user has their own (R1). */
export interface SessionCore {
  readonly id: string;
  readonly roomId: string | null;
  /** The attached "what am I working on" task (F-29); attachability is checked by the service. */
  readonly taskId: string | null;
  readonly startedAt: EpochMs;
  /** Non-null iff STUDYING. */
  readonly currentSegmentStartedAt: EpochMs | null;
  /** Non-null iff ON_BREAK or BREAK_OVER. */
  readonly currentBreak: BreakCore | null;
  /** Non-null while in the 2-minute disconnect grace (row 8); the phase is unchanged. */
  readonly disconnectedAt?: EpochMs | null;
  readonly version: number;
}

export type TimerCommand =
  | { readonly type: 'START'; readonly roomId: string | null; readonly taskId?: string | null }
  | { readonly type: 'TAKE_BREAK'; readonly sessionId: string; readonly durationMinutes: number }
  | { readonly type: 'RESUME'; readonly sessionId: string }
  | { readonly type: 'END'; readonly sessionId: string }
  | { readonly type: 'MOVE_TO_ROOM'; readonly roomId: string }
  | { readonly type: 'SET_TASK'; readonly sessionId: string; readonly taskId: string | null };

export interface DecideContext {
  readonly now: EpochMs;
  /** Id for a session created by START. */
  readonly newSessionId: string;
  /** The room the user is present in (any of their sockets), or null. */
  readonly userPresenceRoomId: string | null;
  /** The room the calling socket is present in, or null. */
  readonly callerRoomId: string | null;
}

export type SegmentEndReason = 'BREAK' | 'ENDED_BY_USER' | 'ROOM_MOVE' | 'DISCONNECTED';
export type BreakCloseReason = 'RESUMED' | 'ENDED_BY_USER' | 'DISCONNECTED' | 'IDLE_TIMEOUT';
export type SessionEndReason = 'USER' | 'DISCONNECTED' | 'IDLE_TIMEOUT';

export type Effect =
  | {
      readonly type: 'CREATE_SESSION';
      readonly at: EpochMs;
      readonly roomId: string | null;
      readonly taskId: string | null;
    }
  | { readonly type: 'OPEN_SEGMENT'; readonly at: EpochMs; readonly roomId: string | null }
  | { readonly type: 'CLOSE_SEGMENT'; readonly at: EpochMs; readonly reason: SegmentEndReason }
  | {
      readonly type: 'OPEN_BREAK';
      readonly at: EpochMs;
      readonly durationMinutes: BreakMinutes;
      readonly endsAt: EpochMs;
    }
  | { readonly type: 'CLOSE_BREAK'; readonly at: EpochMs; readonly reason: BreakCloseReason }
  | { readonly type: 'SET_ROOM'; readonly roomId: string }
  | { readonly type: 'SET_TASK'; readonly taskId: string | null }
  | { readonly type: 'SET_DISCONNECTED'; readonly at: EpochMs | null }
  | { readonly type: 'END_SESSION'; readonly at: EpochMs; readonly reason: SessionEndReason };

export type UserEventType =
  'STARTED' | 'BREAK_TAKEN' | 'RESUMED' | 'ENDED' | 'MOVED_TO_ROOM' | 'TASK_SET';
export type SystemEventType =
  'DISCONNECTED' | 'LEASE_LOST' | 'RECONNECTED' | 'GRACE_EXPIRED' | 'IDLE_TIMEOUT';
export type TimerEventType = UserEventType | SystemEventType;

export interface TimerEvent {
  readonly type: TimerEventType;
  readonly actor: 'USER' | 'SYSTEM';
  readonly fromPhase: PhaseOrNone;
  readonly toPhase: PhaseOrNone | 'ENDED';
  readonly at: EpochMs;
}

export type DecideResult =
  | {
      readonly ok: true;
      /** The session after the command, or null when it ended. */
      readonly next: SessionCore | null;
      readonly effects: readonly Effect[];
      readonly event: TimerEvent;
    }
  | {
      readonly ok: false;
      readonly code: TimerRejectionCode;
      readonly details?: { readonly breakEndsAt?: EpochMs };
    };

/** §13.2: the phase is derived from the session and the current instant. */
export function phaseOf(session: SessionCore | null, now: EpochMs): PhaseOrNone {
  if (session === null) return 'NO_SESSION';
  if (session.currentSegmentStartedAt !== null) return 'STUDYING';
  if (session.currentBreak === null) {
    // Unreachable for a valid session (studying XOR on a break); guarded by the store.
    throw new Error(`Invalid session ${session.id}: neither studying nor on a break`);
  }
  return now < session.currentBreak.endsAt ? 'ON_BREAK' : 'BREAK_OVER';
}

const reject = (code: TimerRejectionCode, details?: { breakEndsAt?: EpochMs }): DecideResult =>
  details ? { ok: false, code, details } : { ok: false, code };

/**
 * Decide the outcome of a user command against the user's ACTIVE session (or null).
 * Pure: the same inputs always give the same result.
 */
export function decide(
  session: SessionCore | null,
  command: TimerCommand,
  ctx: DecideContext,
): DecideResult {
  const { now } = ctx;
  const from = phaseOf(session, now);

  switch (command.type) {
    case 'START': {
      // Row 13: one active session per user (R6).
      if (session !== null) return reject('SESSION_ALREADY_ACTIVE');
      // Row 1 guard / I-07: start in the room the caller is in; never solo while in a room.
      if (command.roomId !== null) {
        if (ctx.callerRoomId !== command.roomId) return reject('MUST_START_IN_CURRENT_ROOM');
      } else if (ctx.userPresenceRoomId !== null) {
        return reject('MUST_START_IN_CURRENT_ROOM');
      }
      const taskId = command.taskId ?? null;
      const next: SessionCore = {
        id: ctx.newSessionId,
        roomId: command.roomId,
        taskId,
        startedAt: now,
        currentSegmentStartedAt: now,
        currentBreak: null,
        version: 1,
      };
      return {
        ok: true,
        next,
        effects: [
          { type: 'CREATE_SESSION', at: now, roomId: command.roomId, taskId },
          { type: 'OPEN_SEGMENT', at: now, roomId: command.roomId },
        ],
        event: { type: 'STARTED', actor: 'USER', fromPhase: from, toPhase: 'STUDYING', at: now },
      };
    }

    case 'TAKE_BREAK': {
      // Row 20: invalid durations are rejected before anything else (R4).
      if (!isBreakMinutes(command.durationMinutes)) return reject('VALIDATION_ERROR');
      if (session === null) return reject('NO_ACTIVE_SESSION'); // row 17
      if (command.sessionId !== session.id) return reject('STALE_SESSION'); // row 18
      if (from !== 'STUDYING') return reject('NOT_STUDYING'); // row 14
      const endsAt = now + minutesToMs(command.durationMinutes);
      // Row 2 / R3: the segment closes at the exact instant the break opens.
      return {
        ok: true,
        next: {
          ...session,
          currentSegmentStartedAt: null,
          currentBreak: { durationMinutes: command.durationMinutes, startedAt: now, endsAt },
          version: session.version + 1,
        },
        effects: [
          { type: 'CLOSE_SEGMENT', at: now, reason: 'BREAK' },
          { type: 'OPEN_BREAK', at: now, durationMinutes: command.durationMinutes, endsAt },
        ],
        event: {
          type: 'BREAK_TAKEN',
          actor: 'USER',
          fromPhase: from,
          toPhase: 'ON_BREAK',
          at: now,
        },
      };
    }

    case 'RESUME': {
      if (session === null) return reject('NO_ACTIVE_SESSION'); // row 17
      if (command.sessionId !== session.id) return reject('STALE_SESSION'); // row 18
      if (from === 'STUDYING') return reject('NOT_ON_BREAK'); // row 16
      if (from === 'ON_BREAK') {
        // Row 15 / I-05 / R5: no early resume.
        return reject('BREAK_NOT_OVER', { breakEndsAt: session.currentBreak!.endsAt });
      }
      // Row 21 / D-7: a room session can only be resumed from a socket present in its room.
      if (session.roomId !== null && ctx.callerRoomId !== session.roomId) {
        return reject('NOT_IN_SESSION_ROOM');
      }
      // Row 4: BREAK_OVER → STUDYING, only by the user.
      return {
        ok: true,
        next: {
          ...session,
          currentSegmentStartedAt: now,
          currentBreak: null,
          version: session.version + 1,
        },
        effects: [
          { type: 'CLOSE_BREAK', at: now, reason: 'RESUMED' },
          { type: 'OPEN_SEGMENT', at: now, roomId: session.roomId },
        ],
        event: { type: 'RESUMED', actor: 'USER', fromPhase: from, toPhase: 'STUDYING', at: now },
      };
    }

    case 'END': {
      if (session === null) return reject('NO_ACTIVE_SESSION'); // row 17
      if (command.sessionId !== session.id) return reject('STALE_SESSION'); // row 18
      // Rows 5–6: End Study from any phase; close whatever is open at `now`.
      const close: Effect =
        from === 'STUDYING'
          ? { type: 'CLOSE_SEGMENT', at: now, reason: 'ENDED_BY_USER' }
          : { type: 'CLOSE_BREAK', at: now, reason: 'ENDED_BY_USER' };
      return {
        ok: true,
        next: null,
        effects: [close, { type: 'END_SESSION', at: now, reason: 'USER' }],
        event: { type: 'ENDED', actor: 'USER', fromPhase: from, toPhase: 'ENDED', at: now },
      };
    }

    case 'MOVE_TO_ROOM': {
      if (session === null) return reject('NO_ACTIVE_SESSION');
      if (session.roomId === command.roomId) {
        throw new Error('MOVE_TO_ROOM into the session’s own room is not a transition');
      }
      // Row 19: a session lives in one room; room A → room B requires End Study first.
      if (session.roomId !== null) return reject('SESSION_IN_OTHER_ROOM');
      // Row 11: a solo session moves into the room. If studying, split the segment at `now`
      // so the solo part stays solo (F-12, F-15). The displayed total is unchanged.
      const effects: Effect[] =
        from === 'STUDYING'
          ? [
              { type: 'CLOSE_SEGMENT', at: now, reason: 'ROOM_MOVE' },
              { type: 'OPEN_SEGMENT', at: now, roomId: command.roomId },
              { type: 'SET_ROOM', roomId: command.roomId },
            ]
          : [{ type: 'SET_ROOM', roomId: command.roomId }];
      return {
        ok: true,
        next: {
          ...session,
          roomId: command.roomId,
          currentSegmentStartedAt: from === 'STUDYING' ? now : null,
          version: session.version + 1,
        },
        effects,
        event: { type: 'MOVED_TO_ROOM', actor: 'USER', fromPhase: from, toPhase: from, at: now },
      };
    }

    case 'SET_TASK': {
      if (session === null) return reject('NO_ACTIVE_SESSION'); // row 17
      if (command.sessionId !== session.id) return reject('STALE_SESSION'); // row 18
      // Row 12: attach or clear the task in any phase; the phase never changes.
      return {
        ok: true,
        next: { ...session, taskId: command.taskId, version: session.version + 1 },
        effects: [{ type: 'SET_TASK', taskId: command.taskId }],
        event: { type: 'TASK_SET', actor: 'USER', fromPhase: from, toPhase: from, at: now },
      };
    }
  }
}
