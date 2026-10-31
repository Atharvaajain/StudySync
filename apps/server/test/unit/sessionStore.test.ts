/**
 * STORE-INVARIANTS — the Phase 0 equivalent of INT-SCHEMA (TESTING_STRATEGY §5.4): every
 * integrity rule of the in-memory store rejects its violation, and a rejected write leaves
 * the store unchanged (all-or-nothing). The transitions here deliberately bypass the timer
 * machine to prove the store is a last line of defense on its own.
 */
import { describe, expect, it } from 'vitest';
import type { Effect, SessionCore, TimerEvent } from '@studysync/shared';
import { IntegrityError } from '../../src/lib/errors';
import { InMemorySessionStore, type Transition } from '../../src/modules/sessions/sessionStore';

const MIN = 60_000;
const T = Date.parse('2026-11-01T10:00:00.000Z');
const ROOM = '5e1f0d5a-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';

let n = 0;
const ids = () => `id-${++n}`;

const ev = (
  type: TimerEvent['type'],
  at: number,
  fromPhase: TimerEvent['fromPhase'],
  toPhase: TimerEvent['toPhase'],
): TimerEvent => ({
  type,
  actor: 'USER',
  fromPhase,
  toPhase,
  at,
});

function start(
  store: InMemorySessionStore,
  sessionId: string,
  at: number,
  commandId: string | null = null,
): SessionCore {
  const next: SessionCore = {
    id: sessionId,
    roomId: ROOM,
    startedAt: at,
    currentSegmentStartedAt: at,
    currentBreak: null,
    version: 1,
  };
  store.apply({
    userId: USER,
    sessionId,
    next,
    effects: [
      { type: 'CREATE_SESSION', at, roomId: ROOM },
      { type: 'OPEN_SEGMENT', at, roomId: ROOM },
    ],
    event: ev('STARTED', at, 'NO_SESSION', 'STUDYING'),
    commandId,
  });
  return next;
}

function takeBreak(
  store: InMemorySessionStore,
  s: SessionCore,
  at: number,
  minutes: number,
  endsAt = at + minutes * MIN,
): SessionCore {
  const next: SessionCore = {
    ...s,
    currentSegmentStartedAt: null,
    currentBreak: { durationMinutes: minutes as 5, startedAt: at, endsAt },
    version: s.version + 1,
  };
  store.apply({
    userId: USER,
    sessionId: s.id,
    next,
    effects: [
      { type: 'CLOSE_SEGMENT', at, reason: 'BREAK' },
      { type: 'OPEN_BREAK', at, durationMinutes: minutes as 5, endsAt },
    ],
    event: ev('BREAK_TAKEN', at, 'STUDYING', 'ON_BREAK'),
    commandId: null,
  });
  return next;
}

function end(store: InMemorySessionStore, s: SessionCore, at: number, onBreak: boolean): void {
  const close: Effect = onBreak
    ? { type: 'CLOSE_BREAK', at, reason: 'ENDED_BY_USER' }
    : { type: 'CLOSE_SEGMENT', at, reason: 'ENDED_BY_USER' };
  store.apply({
    userId: USER,
    sessionId: s.id,
    next: null,
    effects: [close, { type: 'END_SESSION', at, reason: 'USER' }],
    event: ev('ENDED', at, onBreak ? 'ON_BREAK' : 'STUDYING', 'ENDED'),
    commandId: null,
  });
}

function expectViolation(store: InMemorySessionStore, constraint: string, write: () => void): void {
  const before = JSON.stringify({ sessions: store.allSessions(), audit: store.audit() });
  let caught: unknown;
  try {
    write();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${constraint}`).toBeInstanceOf(IntegrityError);
  expect((caught as IntegrityError).constraint).toBe(constraint);
  // All-or-nothing: nothing changed.
  expect(JSON.stringify({ sessions: store.allSessions(), audit: store.audit() })).toBe(before);
}

describe('in-memory store integrity rules (mirror of DATABASE_DESIGN §5)', () => {
  it('accepts a valid history and passes the audit', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    const b = takeBreak(store, s, T + 30 * MIN, 10);
    const resumed: SessionCore = {
      ...b,
      currentSegmentStartedAt: T + 45 * MIN,
      currentBreak: null,
      version: b.version + 1,
    };
    store.apply({
      userId: USER,
      sessionId: 's1',
      next: resumed,
      effects: [
        { type: 'CLOSE_BREAK', at: T + 45 * MIN, reason: 'RESUMED' },
        { type: 'OPEN_SEGMENT', at: T + 45 * MIN, roomId: ROOM },
      ],
      event: ev('RESUMED', T + 45 * MIN, 'BREAK_OVER', 'STUDYING'),
      commandId: null,
    });
    end(store, resumed, T + 60 * MIN, false);
    expect(store.audit()).toEqual([]);
    expect(store.segmentsOf('s1').map((g) => [g.startedAt, g.endedAt])).toEqual([
      [T, T + 30 * MIN],
      [T + 45 * MIN, T + 60 * MIN],
    ]);
  });

  it('study_sessions_one_active_per_user (R6)', () => {
    const store = new InMemorySessionStore(ids);
    start(store, 's1', T);
    expectViolation(store, 'study_sessions_one_active_per_user', () => start(store, 's2', T + MIN));
  });

  it('brk_duration_allowed (R4): a 20-minute break is impossible', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    expectViolation(store, 'brk_duration_allowed', () => takeBreak(store, s, T + MIN, 20));
  });

  it('brk_ends_exact: ends_at must equal start + duration', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    expectViolation(store, 'brk_ends_exact', () => takeBreak(store, s, T + MIN, 10, T + 10 * MIN));
  });

  it('brk_resume_only_after_end (R5): no resume before the countdown ends', () => {
    const store = new InMemorySessionStore(ids);
    const b = takeBreak(store, start(store, 's1', T), T + 5 * MIN, 10);
    const early = T + 10 * MIN; // countdown ends at T + 15 min
    expectViolation(store, 'brk_resume_only_after_end', () =>
      store.apply({
        userId: USER,
        sessionId: 's1',
        next: { ...b, currentSegmentStartedAt: early, currentBreak: null, version: b.version + 1 },
        effects: [
          { type: 'CLOSE_BREAK', at: early, reason: 'RESUMED' },
          { type: 'OPEN_SEGMENT', at: early, roomId: ROOM },
        ],
        event: ev('RESUMED', early, 'ON_BREAK', 'STUDYING'),
        commandId: null,
      }),
    );
  });

  it('ss_active_phase_xor: never studying and on a break at once', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    expectViolation(store, 'ss_active_phase_xor', () =>
      store.apply({
        userId: USER,
        sessionId: 's1',
        next: {
          ...s,
          currentBreak: { durationMinutes: 5, startedAt: T + MIN, endsAt: T + 6 * MIN },
          version: 2,
        },
        effects: [{ type: 'OPEN_BREAK', at: T + MIN, durationMinutes: 5, endsAt: T + 6 * MIN }],
        event: ev('BREAK_TAKEN', T + MIN, 'STUDYING', 'ON_BREAK'),
        commandId: null,
      }),
    );
  });

  it('seg_no_overlap_per_user: a new segment cannot overlap an old one', () => {
    const store = new InMemorySessionStore(ids);
    end(store, start(store, 's1', T), T + 30 * MIN, false);
    expectViolation(store, 'seg_no_overlap_per_user', () => start(store, 's2', T + 10 * MIN));
  });

  it('segment_break_no_overlap (audit A, R3): study can never overlap a break', () => {
    const store = new InMemorySessionStore(ids);
    const b = takeBreak(store, start(store, 's1', T), T + 30 * MIN, 30);
    end(store, b, T + 40 * MIN, true); // break [T+30, T+40)
    expectViolation(store, 'segment_break_no_overlap', () => start(store, 's2', T + 35 * MIN));
  });

  it('ss_ended_terminal: an ended session never changes', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    end(store, s, T + MIN, false);
    expectViolation(store, 'ss_ended_terminal', () => takeBreak(store, s, T + 2 * MIN, 5));
  });

  it('session_events_user_id_command_id_key: a commandId is applied once', () => {
    const store = new InMemorySessionStore(ids);
    end(store, start(store, 's1', T, 'cmd-1'), T + MIN, false);
    expectViolation(store, 'session_events_user_id_command_id_key', () =>
      start(store, 's2', T + 2 * MIN, 'cmd-1'),
    );
  });

  it('evt_actor_matches_type: a SYSTEM actor cannot start a session (no automatic start/resume)', () => {
    const store = new InMemorySessionStore(ids);
    const next: SessionCore = {
      id: 's1',
      roomId: ROOM,
      startedAt: T,
      currentSegmentStartedAt: T,
      currentBreak: null,
      version: 1,
    };
    const t: Transition = {
      userId: USER,
      sessionId: 's1',
      next,
      effects: [
        { type: 'CREATE_SESSION', at: T, roomId: ROOM },
        { type: 'OPEN_SEGMENT', at: T, roomId: ROOM },
      ],
      event: { ...ev('STARTED', T, 'NO_SESSION', 'STUDYING'), actor: 'SYSTEM' as 'USER' },
      commandId: null,
    };
    expectViolation(store, 'evt_actor_matches_type', () => store.apply(t));
  });

  it('machine_store_agreement: effects that disagree with the next state are rejected', () => {
    const store = new InMemorySessionStore(ids);
    const s = start(store, 's1', T);
    expectViolation(store, 'machine_store_agreement', () =>
      store.apply({
        userId: USER,
        sessionId: 's1',
        next: { ...s, version: 2 }, // claims still studying…
        effects: [{ type: 'CLOSE_SEGMENT', at: T + MIN, reason: 'BREAK' }], // …but closes the segment
        event: ev('BREAK_TAKEN', T + MIN, 'STUDYING', 'ON_BREAK'),
        commandId: null,
      }),
    );
  });
});
