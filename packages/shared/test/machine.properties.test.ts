/**
 * Property-based tests of the timer core (TESTING_STRATEGY §5.1, P1–P4, P8, P9).
 * fast-check generates random histories (valid and invalid commands, time jumps up to 3 h,
 * presence changes, solo → room moves); the model applies accepted effects exactly as the
 * store would, and the properties must hold for every history.
 * P5–P7 (auto-save / liveness) apply from Phase 2.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BREAK_DURATIONS_MINUTES,
  decide,
  phaseOf,
  type Effect,
  type SessionCore,
  type TimerCommand,
  type TimerEvent,
} from '../src';

const ROOM = '5e1f0d5a-0000-4000-8000-000000000001';
const MIN = 60_000;
const RUNS = Number(process.env.FC_RUNS ?? 10_000);

type Step =
  | { kind: 'advance'; ms: number }
  | { kind: 'start'; solo: boolean }
  | { kind: 'break'; d: number }
  | { kind: 'resume' }
  | { kind: 'end' }
  | { kind: 'stale' }
  | { kind: 'move' }
  | { kind: 'presence'; inRoom: boolean };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.integer({ min: 0, max: 3 * 60 * MIN }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('start' as const), solo: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('break' as const),
      d: fc.constantFrom(5, 10, 15, 30, 0, 1, 20, 45, -5, 7.5),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('resume' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('end' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stale' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('move' as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('presence' as const), inRoom: fc.boolean() }),
  },
);

interface Model {
  t: number;
  inRoom: boolean;
  active: SessionCore | null;
  sessions: Map<
    string,
    {
      status: 'ACTIVE' | 'ENDED';
      startedAt: number;
      endedAt: number | null;
      versions: number[];
      rooms: (string | null)[];
    }
  >;
  segments: { sessionId: string; start: number; end: number | null }[];
  breaks: {
    sessionId: string;
    d: number;
    start: number;
    endsAt: number;
    closedAt: number | null;
    reason: string | null;
  }[];
  events: TimerEvent[];
}

function applyEffects(m: Model, sessionId: string, effects: readonly Effect[]): void {
  for (const e of effects) {
    switch (e.type) {
      case 'CREATE_SESSION':
        m.sessions.set(sessionId, {
          status: 'ACTIVE',
          startedAt: e.at,
          endedAt: null,
          versions: [],
          rooms: [e.roomId],
        });
        break;
      case 'OPEN_SEGMENT':
        m.segments.push({ sessionId, start: e.at, end: null });
        break;
      case 'CLOSE_SEGMENT': {
        const open = m.segments.find((s) => s.sessionId === sessionId && s.end === null);
        if (!open) throw new Error('CLOSE_SEGMENT without an open segment');
        open.end = e.at;
        break;
      }
      case 'OPEN_BREAK':
        m.breaks.push({
          sessionId,
          d: e.durationMinutes,
          start: e.at,
          endsAt: e.endsAt,
          closedAt: null,
          reason: null,
        });
        break;
      case 'CLOSE_BREAK': {
        const open = m.breaks.find((b) => b.sessionId === sessionId && b.closedAt === null);
        if (!open) throw new Error('CLOSE_BREAK without an open break');
        open.closedAt = e.at;
        open.reason = e.reason;
        break;
      }
      case 'SET_ROOM':
        m.sessions.get(sessionId)!.rooms.push(e.roomId);
        break;
      case 'END_SESSION': {
        const s = m.sessions.get(sessionId)!;
        s.status = 'ENDED';
        s.endedAt = e.at;
        break;
      }
    }
  }
}

function run(steps: Step[]): Model {
  const m: Model = {
    t: Date.parse('2026-11-01T08:00:00.000Z'),
    inRoom: true,
    active: null,
    sessions: new Map(),
    segments: [],
    breaks: [],
    events: [],
  };
  let n = 0;
  for (const step of steps) {
    if (step.kind === 'advance') {
      m.t += step.ms;
      continue;
    }
    if (step.kind === 'presence') {
      m.inRoom = step.inRoom;
      continue;
    }
    const sid = m.active?.id ?? 'none';
    let command: TimerCommand;
    switch (step.kind) {
      case 'start':
        command = { type: 'START', roomId: step.solo ? null : ROOM };
        break;
      case 'break':
        command = { type: 'TAKE_BREAK', sessionId: sid, durationMinutes: step.d };
        break;
      case 'resume':
        command = { type: 'RESUME', sessionId: sid };
        break;
      case 'end':
        command = { type: 'END', sessionId: sid };
        break;
      case 'stale':
        command = { type: 'END', sessionId: 'stale-session-id' };
        break;
      case 'move':
        if (m.active?.roomId === ROOM) continue; // not a transition (the service never calls it)
        command = { type: 'MOVE_TO_ROOM', roomId: ROOM };
        break;
    }
    const room = m.inRoom ? ROOM : null;
    const result = decide(m.active, command, {
      now: m.t,
      newSessionId: `s${++n}`,
      userPresenceRoomId: room,
      callerRoomId: room,
    });
    if (!result.ok) continue;
    const sessionId = result.next?.id ?? m.active!.id;
    applyEffects(m, sessionId, result.effects);
    const record = m.sessions.get(sessionId)!;
    record.versions.push(result.next?.version ?? (record.versions.at(-1) ?? 0) + 1);
    m.events.push(result.event);
    m.active = result.next;
  }
  return m;
}

const overlaps = (a0: number, a1: number | null, b0: number, b1: number | null) =>
  a0 < (b1 ?? Infinity) && b0 < (a1 ?? Infinity);

describe('timer core properties', () => {
  it('P1 segments and breaks never overlap; P2 they fit inside the session span (R3)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const m = run(steps);
        const intervals = [
          ...m.segments.map((s) => [s.start, s.end] as const),
          ...m.breaks.map((b) => [b.start, b.closedAt] as const),
        ].filter(([a, b]) => b === null || b > a);
        for (let i = 0; i < intervals.length; i++)
          for (let j = i + 1; j < intervals.length; j++) {
            const [a0, a1] = intervals[i]!;
            const [b0, b1] = intervals[j]!;
            expect(overlaps(a0, a1, b0, b1)).toBe(false);
          }
        for (const [id, s] of m.sessions) {
          const end = s.endedAt ?? m.t;
          const study = m.segments
            .filter((g) => g.sessionId === id)
            .reduce((x, g) => x + ((g.end ?? m.t) - g.start), 0);
          const brk = m.breaks
            .filter((b) => b.sessionId === id)
            .reduce((x, b) => x + ((b.closedAt ?? m.t) - b.start), 0);
          expect(study + brk).toBeLessThanOrEqual(end - s.startedAt);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('P3 every entry into STUDYING is a user start/resume (R5: no automatic resume)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        for (const e of run(steps).events) {
          if (e.toPhase === 'STUDYING' && e.fromPhase !== 'STUDYING') {
            expect(['STARTED', 'RESUMED']).toContain(e.type);
            expect(e.actor).toBe('USER');
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('P4 breaks are 5/10/15/30 min, end exactly on time, and resume only after the countdown (R4, R5)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        for (const b of run(steps).breaks) {
          expect(BREAK_DURATIONS_MINUTES).toContain(b.d);
          expect(b.endsAt).toBe(b.start + b.d * MIN);
          if (b.reason === 'RESUMED') expect(b.closedAt!).toBeGreaterThanOrEqual(b.endsAt);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('P8 versions strictly increase; P9 at most one active session, ENDED is terminal, room changes once from solo', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const m = run(steps);
        expect(
          [...m.sessions.values()].filter((s) => s.status === 'ACTIVE').length,
        ).toBeLessThanOrEqual(1);
        for (const [id, s] of m.sessions) {
          for (let i = 1; i < s.versions.length; i++)
            expect(s.versions[i]!).toBeGreaterThan(s.versions[i - 1]!);
          if (s.status === 'ENDED') {
            for (const g of m.segments.filter((x) => x.sessionId === id))
              expect(g.end).not.toBeNull();
            for (const b of m.breaks.filter((x) => x.sessionId === id))
              expect(b.closedAt).not.toBeNull();
          }
          expect(s.rooms.length).toBeLessThanOrEqual(2);
          if (s.rooms.length === 2) expect(s.rooms[0]).toBeNull();
        }
        if (m.active) expect(phaseOf(m.active, m.t)).not.toBe('NO_SESSION');
      }),
      { numRuns: RUNS },
    );
  });
});
