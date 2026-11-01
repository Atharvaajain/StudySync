/**
 * System transitions (ARCHITECTURE §13.4 rows 7–10): an exhaustive phase × system-event table,
 * plus P5 (late processing = on-time processing), P6 (idle at exactly ends_at + 30 min) and
 * P7 (grace: back in time → nothing changes; otherwise ended at the loss instant).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BREAK_OVER_IDLE_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  decideSystem,
  dueAutoSave,
  phaseOf,
  type ServerToClientEvents,
  type SessionCore,
  type SystemEvent,
} from '../src';

const T = Date.parse('2026-11-01T10:00:00.000Z');
const MIN = 60_000;
const base = { id: 's1', roomId: null, taskId: null, startedAt: T - 60 * MIN, version: 3 };

const studying: SessionCore = {
  ...base,
  currentSegmentStartedAt: T - 10 * MIN,
  currentBreak: null,
};
const onBreak: SessionCore = {
  ...base,
  currentSegmentStartedAt: null,
  currentBreak: { durationMinutes: 10, startedAt: T - MIN, endsAt: T + 9 * MIN },
};
const breakOver: SessionCore = {
  ...base,
  currentSegmentStartedAt: null,
  currentBreak: { durationMinutes: 5, startedAt: T - 10 * MIN, endsAt: T - 5 * MIN },
};
const inGrace = (s: SessionCore, at = T - MIN): SessionCore => ({ ...s, disconnectedAt: at });

type Outcome = string; // event type, or `noop:<reason>`
const run = (s: SessionCore | null, e: SystemEvent): Outcome => {
  const r = decideSystem(s, e);
  return r.ok ? r.event.type : `noop:${r.noop}`;
};

const events: Record<string, SystemEvent> = {
  lost: { type: 'LIVENESS_LOST', at: T, cause: 'DISCONNECTED' },
  lease_lost: { type: 'LIVENESS_LOST', at: T, cause: 'LEASE_LOST' },
  regained: { type: 'LIVENESS_REGAINED', at: T },
  auto_save_now: { type: 'AUTO_SAVE', now: T },
};

const fixtures: Record<string, SessionCore | null> = {
  NO_SESSION: null,
  STUDYING: studying,
  ON_BREAK: onBreak,
  BREAK_OVER: breakOver,
  STUDYING_IN_GRACE: inGrace(studying),
  ON_BREAK_IN_GRACE: inGrace(onBreak),
};

const table: Record<string, Record<string, Outcome>> = {
  NO_SESSION: {
    lost: 'noop:NO_SESSION',
    lease_lost: 'noop:NO_SESSION',
    regained: 'noop:NO_SESSION',
    auto_save_now: 'noop:NO_SESSION',
  },
  STUDYING: {
    lost: 'DISCONNECTED', // row 8
    lease_lost: 'LEASE_LOST',
    regained: 'noop:NOT_DISCONNECTED',
    auto_save_now: 'noop:NOT_DUE',
  },
  ON_BREAK: {
    lost: 'DISCONNECTED',
    lease_lost: 'LEASE_LOST',
    regained: 'noop:NOT_DISCONNECTED',
    auto_save_now: 'noop:NOT_DUE',
  },
  BREAK_OVER: {
    lost: 'DISCONNECTED',
    lease_lost: 'LEASE_LOST',
    regained: 'noop:NOT_DISCONNECTED',
    auto_save_now: 'noop:NOT_DUE', // 5 min into Break Over: the idle deadline is 25 min away
  },
  STUDYING_IN_GRACE: {
    lost: 'noop:ALREADY_DISCONNECTED',
    lease_lost: 'noop:ALREADY_DISCONNECTED',
    regained: 'RECONNECTED', // row 9
    auto_save_now: 'noop:NOT_DUE', // 1 min into grace
  },
  ON_BREAK_IN_GRACE: {
    lost: 'noop:ALREADY_DISCONNECTED',
    lease_lost: 'noop:ALREADY_DISCONNECTED',
    regained: 'RECONNECTED',
    auto_save_now: 'noop:NOT_DUE',
  },
};

describe('system transitions — exhaustive table', () => {
  for (const [f, session] of Object.entries(fixtures)) {
    for (const [e, event] of Object.entries(events)) {
      it(`${f} × ${e} → ${table[f]![e]}`, () => {
        expect(table[f]![e], 'missing expectation').toBeDefined();
        expect(run(session, event)).toBe(table[f]![e]);
      });
    }
  }

  it('liveness changes never change the phase and are system events', () => {
    for (const s of [studying, onBreak, breakOver]) {
      const lost = decideSystem(s, events.lost!);
      expect(lost.ok && lost.event).toMatchObject({ actor: 'SYSTEM', fromPhase: phaseOf(s, T) });
      if (!lost.ok) throw new Error('expected a transition');
      expect(phaseOf(lost.next, T)).toBe(phaseOf(s, T));
      expect(lost.next).toMatchObject({ disconnectedAt: T, version: 4 });
      const back = decideSystem(lost.next, events.regained!);
      if (!back.ok) throw new Error('expected a transition');
      expect(back.next).toMatchObject({ disconnectedAt: null, version: 5 });
      expect(back.event.toPhase).toBe(phaseOf(s, T)); // R5: never INTO studying
    }
  });
});

describe('auto-save (rows 7 and 10)', () => {
  it('row 10: grace expiry ends the session at the disconnect instant', () => {
    const s = inGrace(studying, T);
    expect(dueAutoSave(s, T + DISCONNECT_GRACE_MS - 1)).toBeNull();
    const r = decideSystem(s, { type: 'AUTO_SAVE', now: T + DISCONNECT_GRACE_MS });
    if (!r.ok) throw new Error('expected an auto-save');
    expect(r.next).toBeNull();
    expect(r.event).toMatchObject({
      type: 'GRACE_EXPIRED',
      actor: 'SYSTEM',
      toPhase: 'ENDED',
      at: T + DISCONNECT_GRACE_MS, // stamped at the deadline
    });
    expect(r.effects).toEqual([
      { type: 'CLOSE_SEGMENT', at: T, reason: 'DISCONNECTED' },
      { type: 'END_SESSION', at: T, reason: 'DISCONNECTED' },
    ]);
  });

  it('row 7 / P6: idle in Break Over ends exactly at ends_at + 30 min', () => {
    const deadline = breakOver.currentBreak!.endsAt + BREAK_OVER_IDLE_TIMEOUT_MS;
    expect(dueAutoSave(breakOver, deadline - 1)).toBeNull();
    const r = decideSystem(breakOver, { type: 'AUTO_SAVE', now: deadline + 3_600_000 });
    if (!r.ok) throw new Error('expected an auto-save');
    expect(r.event).toMatchObject({ type: 'IDLE_TIMEOUT', at: deadline, fromPhase: 'BREAK_OVER' });
    expect(r.effects).toEqual([
      { type: 'CLOSE_BREAK', at: deadline, reason: 'IDLE_TIMEOUT' },
      { type: 'END_SESSION', at: deadline, reason: 'IDLE_TIMEOUT' },
    ]);
  });

  it('the earliest deadline wins when grace and idle overlap', () => {
    // In Break Over since T−5 min (idle at T+25 min) and disconnected at T (grace at T+2 min).
    const r = decideSystem(inGrace(breakOver, T), { type: 'AUTO_SAVE', now: T + 60 * MIN });
    expect(r.ok && r.event.type).toBe('GRACE_EXPIRED');
    const late = inGrace(breakOver, T + 24 * MIN); // grace would end after the idle deadline
    const r2 = decideSystem(late, { type: 'AUTO_SAVE', now: T + 60 * MIN });
    expect(r2.ok && r2.event.type).toBe('IDLE_TIMEOUT');
  });

  it('P5: applying a due auto-save late gives the same result as on time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 * MIN }),
        fc.integer({ min: 0, max: 48 * 60 * MIN }),
        fc.boolean(),
        (lostAfter, lateBy, studyingWhenLost) => {
          const s0 = studyingWhenLost ? studying : onBreak;
          const lostAt = T + lostAfter;
          const lost = decideSystem(s0, {
            type: 'LIVENESS_LOST',
            at: lostAt,
            cause: 'DISCONNECTED',
          });
          if (!lost.ok) return false;
          const due = dueAutoSave(lost.next, Number.MAX_SAFE_INTEGER)!;
          const onTime = decideSystem(lost.next, { type: 'AUTO_SAVE', now: due.at });
          const late = decideSystem(lost.next, { type: 'AUTO_SAVE', now: due.at + lateBy });
          expect(late).toEqual(onTime);
          return true;
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 2_000) },
    );
  });

  it('P7: back within 2 min → the phase is unchanged; otherwise nothing after the loss counts', () => {
    const lost = decideSystem(studying, { type: 'LIVENESS_LOST', at: T, cause: 'DISCONNECTED' });
    if (!lost.ok) throw new Error();
    expect(dueAutoSave(lost.next, T + DISCONNECT_GRACE_MS - 1)).toBeNull();
    const back = decideSystem(lost.next, { type: 'LIVENESS_REGAINED', at: T + 119_000 });
    expect(back.ok && phaseOf(back.next, T + 119_000)).toBe('STUDYING');
    const saved = decideSystem(lost.next, { type: 'AUTO_SAVE', now: T + DISCONNECT_GRACE_MS });
    expect(saved.ok && saved.effects[0]).toEqual({
      type: 'CLOSE_SEGMENT',
      at: T,
      reason: 'DISCONNECTED',
    });
  });
});

describe('RT-12 (type level): no room-timer event exists', () => {
  it('server → client events describe presence, own status and tasks only', () => {
    type Names = keyof ServerToClientEvents;
    const names: Record<Names, true> = {
      session_state: true,
      member_joined: true,
      member_left: true,
      status_changed: true,
      room_task_updated: true,
      personal_task_updated: true,
      auth_expired: true,
    };
    expect(
      Object.keys(names).filter((n) => /timer|room_(start|stop|break|resume)/.test(n)),
    ).toEqual([]);
  });
});
