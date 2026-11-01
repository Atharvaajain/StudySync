/**
 * System transitions of the timer (ARCHITECTURE §13.4 rows 7–10, §13.5–§13.7). Pure: no I/O,
 * no clock access. They never move a session INTO studying (R5): liveness changes keep the
 * phase, and the auto-saves end the session.
 *
 *   row 8   liveness lost at T         → disconnected_at = T (phase unchanged)
 *   row 9   liveness regained in time  → disconnected_at cleared (phase unchanged, gap credited)
 *   row 10  grace deadline T + 2 min   → ENDED (DISCONNECTED), open interval closed at T
 *   row 7   idle deadline ends_at + 30 → ENDED (IDLE_TIMEOUT), break closed at the deadline
 *
 * Deadlines are data: whoever applies them (scheduler, sweeper, the next command or read),
 * whenever, the result is stamped at the deadline instant, so a late or restarted server gives
 * the same outcome (P5).
 */
import { BREAK_OVER_IDLE_TIMEOUT_MS, DISCONNECT_GRACE_MS } from '../constants';
import { phaseOf, type Effect, type EpochMs, type SessionCore, type TimerEvent } from './machine';

export interface DueAutoSave {
  readonly reason: 'DISCONNECTED' | 'IDLE_TIMEOUT';
  /** The deadline instant (event `occurredAt`). */
  readonly at: EpochMs;
  /** Where the open interval is closed and the session ends. */
  readonly closeAt: EpochMs;
}

/** The earliest auto-save deadline of the session, whether or not it is due yet. */
export function nextAutoSave(session: SessionCore): DueAutoSave | null {
  const candidates: DueAutoSave[] = [];
  const disconnectedAt = session.disconnectedAt ?? null;
  if (disconnectedAt !== null) {
    const openStart = session.currentSegmentStartedAt ?? session.currentBreak?.startedAt ?? 0;
    candidates.push({
      reason: 'DISCONNECTED',
      at: disconnectedAt + DISCONNECT_GRACE_MS,
      // I-03: nothing after the loss instant counts; clamped to the open interval's start.
      closeAt: Math.max(disconnectedAt, openStart),
    });
  }
  if (session.currentSegmentStartedAt === null && session.currentBreak !== null) {
    const deadline = session.currentBreak.endsAt + BREAK_OVER_IDLE_TIMEOUT_MS;
    candidates.push({ reason: 'IDLE_TIMEOUT', at: deadline, closeAt: deadline });
  }
  // Both end the session: the earliest deadline wins.
  return candidates.reduce<DueAutoSave | null>(
    (first, c) => (first === null || c.at < first.at ? c : first),
    null,
  );
}

/** §13.5 `dueAutoSave`: the auto-save to apply at `now`, or null. */
export function dueAutoSave(session: SessionCore | null, now: EpochMs): DueAutoSave | null {
  if (session === null) return null;
  const next = nextAutoSave(session);
  return next !== null && next.at <= now ? next : null;
}

export type SystemEvent =
  | {
      readonly type: 'LIVENESS_LOST';
      readonly at: EpochMs;
      readonly cause: 'DISCONNECTED' | 'LEASE_LOST';
    }
  | { readonly type: 'LIVENESS_REGAINED'; readonly at: EpochMs }
  | { readonly type: 'AUTO_SAVE'; readonly now: EpochMs };

export type SystemNoop = 'NO_SESSION' | 'ALREADY_DISCONNECTED' | 'NOT_DISCONNECTED' | 'NOT_DUE';

export type SystemResult =
  | {
      readonly ok: true;
      readonly next: SessionCore | null;
      readonly effects: readonly Effect[];
      readonly event: TimerEvent;
    }
  | { readonly ok: false; readonly noop: SystemNoop };

/**
 * Decide a system event. Callers reconcile first (apply a due auto-save), so a liveness change
 * is never applied to a session whose deadline has already passed.
 */
export function decideSystem(session: SessionCore | null, event: SystemEvent): SystemResult {
  if (session === null) return { ok: false, noop: 'NO_SESSION' };
  const disconnectedAt = session.disconnectedAt ?? null;

  switch (event.type) {
    case 'LIVENESS_LOST': {
      // Row 8.
      if (disconnectedAt !== null) return { ok: false, noop: 'ALREADY_DISCONNECTED' };
      const phase = phaseOf(session, event.at);
      return {
        ok: true,
        next: { ...session, disconnectedAt: event.at, version: session.version + 1 },
        effects: [{ type: 'SET_DISCONNECTED', at: event.at }],
        event: {
          type: event.cause,
          actor: 'SYSTEM',
          fromPhase: phase,
          toPhase: phase,
          at: event.at,
        },
      };
    }

    case 'LIVENESS_REGAINED': {
      // Row 9: the phase never changes; the time in grace is credited.
      if (disconnectedAt === null) return { ok: false, noop: 'NOT_DISCONNECTED' };
      const phase = phaseOf(session, event.at);
      return {
        ok: true,
        next: { ...session, disconnectedAt: null, version: session.version + 1 },
        effects: [{ type: 'SET_DISCONNECTED', at: null }],
        event: {
          type: 'RECONNECTED',
          actor: 'SYSTEM',
          fromPhase: phase,
          toPhase: phase,
          at: event.at,
        },
      };
    }

    case 'AUTO_SAVE': {
      // Rows 7 and 10.
      const due = dueAutoSave(session, event.now);
      if (due === null) return { ok: false, noop: 'NOT_DUE' };
      const fromPhase = phaseOf(session, due.at);
      const close: Effect =
        session.currentSegmentStartedAt !== null
          ? { type: 'CLOSE_SEGMENT', at: due.closeAt, reason: 'DISCONNECTED' }
          : { type: 'CLOSE_BREAK', at: due.closeAt, reason: due.reason };
      return {
        ok: true,
        next: null,
        effects: [close, { type: 'END_SESSION', at: due.closeAt, reason: due.reason }],
        event: {
          type: due.reason === 'DISCONNECTED' ? 'GRACE_EXPIRED' : 'IDLE_TIMEOUT',
          actor: 'SYSTEM',
          fromPhase,
          toPhase: 'ENDED',
          at: due.at,
        },
      };
    }
  }
}
