/**
 * Exhaustive transition table for the Phase 0 machine (TESTING_STRATEGY §5.1).
 * Every phase × event-variant pair has an explicit expectation; the completeness test fails
 * if a pair is missing, so a new event can never be added without deciding its behavior
 * in every phase.
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  phaseOf,
  type DecideContext,
  type PhaseOrNone,
  type SessionCore,
  type TimerCommand,
  type TimerRejectionCode,
} from '../src';

const T = Date.parse('2026-11-01T10:00:00.000Z');
const MIN = 60_000;
const ROOM = '5e1f0d5a-0000-4000-8000-000000000001';
const OTHER_ROOM = '5e1f0d5a-0000-4000-8000-000000000002';
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_SID = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const NEW_SID = 'aaaaaaaa-0000-4000-8000-000000000002';
const TASK = 'cccccccc-0000-4000-8000-000000000001';

type Fixture = 'NO_SESSION' | 'STUDYING' | 'ON_BREAK' | 'BREAK_OVER';

const fixtures: Record<Fixture, SessionCore | null> = {
  NO_SESSION: null,
  STUDYING: {
    id: SID,
    roomId: ROOM,
    taskId: null,
    startedAt: T - 60 * MIN,
    currentSegmentStartedAt: T - 10 * MIN,
    currentBreak: null,
    version: 3,
  },
  ON_BREAK: {
    id: SID,
    roomId: ROOM,
    taskId: null,
    startedAt: T - 60 * MIN,
    currentSegmentStartedAt: null,
    currentBreak: { durationMinutes: 10, startedAt: T - MIN, endsAt: T + 9 * MIN },
    version: 4,
  },
  BREAK_OVER: {
    id: SID,
    roomId: ROOM,
    taskId: null,
    startedAt: T - 60 * MIN,
    currentSegmentStartedAt: null,
    currentBreak: { durationMinutes: 5, startedAt: T - 10 * MIN, endsAt: T - 5 * MIN },
    version: 4,
  },
};

interface Variant {
  command: TimerCommand;
  ctx: Partial<DecideContext>;
}

const inRoom = { userPresenceRoomId: ROOM, callerRoomId: ROOM };
const notInRoom = { userPresenceRoomId: null, callerRoomId: null };
const invalidDurations = [0, 1, 20, 25, 45, 60, -5, 7.5] as const;

const variants = {
  start_in_room: { command: { type: 'START', roomId: ROOM }, ctx: inRoom },
  start_room_not_present: { command: { type: 'START', roomId: ROOM }, ctx: notInRoom },
  start_solo: { command: { type: 'START', roomId: null }, ctx: notInRoom },
  start_solo_while_in_room: { command: { type: 'START', roomId: null }, ctx: inRoom },
  break_5: { command: { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: 5 }, ctx: inRoom },
  break_10: { command: { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: 10 }, ctx: inRoom },
  break_15: { command: { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: 15 }, ctx: inRoom },
  break_30: { command: { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: 30 }, ctx: inRoom },
  ...Object.fromEntries(
    invalidDurations.map((d) => [
      `break_invalid_${d}`,
      { command: { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: d }, ctx: inRoom },
    ]),
  ),
  resume_in_room: { command: { type: 'RESUME', sessionId: SID }, ctx: inRoom },
  resume_not_in_room: { command: { type: 'RESUME', sessionId: SID }, ctx: notInRoom },
  end: { command: { type: 'END', sessionId: SID }, ctx: inRoom },
  stale_break: {
    command: { type: 'TAKE_BREAK', sessionId: OTHER_SID, durationMinutes: 10 },
    ctx: inRoom,
  },
  stale_resume: { command: { type: 'RESUME', sessionId: OTHER_SID }, ctx: inRoom },
  stale_end: { command: { type: 'END', sessionId: OTHER_SID }, ctx: inRoom },
  move_to_other_room: { command: { type: 'MOVE_TO_ROOM', roomId: OTHER_ROOM }, ctx: inRoom },
  set_task: { command: { type: 'SET_TASK', sessionId: SID, taskId: TASK }, ctx: notInRoom },
  stale_set_task: {
    command: { type: 'SET_TASK', sessionId: OTHER_SID, taskId: TASK },
    ctx: inRoom,
  },
} satisfies Record<string, Variant>;

type VariantName = keyof typeof variants;
type Expectation = { next: PhaseOrNone | 'ENDED' } | { reject: TimerRejectionCode };

const allInvalid = (e: Expectation) =>
  Object.fromEntries(invalidDurations.map((d) => [`break_invalid_${d}`, e])) as Record<
    `break_invalid_${(typeof invalidDurations)[number]}`,
    Expectation
  >;

const R = (code: TimerRejectionCode): Expectation => ({ reject: code });
const N = (next: PhaseOrNone | 'ENDED'): Expectation => ({ next });

const table: Record<Fixture, Record<VariantName, Expectation>> = {
  NO_SESSION: {
    start_in_room: N('STUDYING'), // row 1
    start_room_not_present: R('MUST_START_IN_CURRENT_ROOM'),
    start_solo: N('STUDYING'),
    start_solo_while_in_room: R('MUST_START_IN_CURRENT_ROOM'), // I-07
    break_5: R('NO_ACTIVE_SESSION'),
    break_10: R('NO_ACTIVE_SESSION'),
    break_15: R('NO_ACTIVE_SESSION'),
    break_30: R('NO_ACTIVE_SESSION'),
    ...allInvalid(R('VALIDATION_ERROR')), // row 20 (validated first)
    resume_in_room: R('NO_ACTIVE_SESSION'), // row 17
    resume_not_in_room: R('NO_ACTIVE_SESSION'),
    end: R('NO_ACTIVE_SESSION'),
    stale_break: R('NO_ACTIVE_SESSION'),
    stale_resume: R('NO_ACTIVE_SESSION'),
    stale_end: R('NO_ACTIVE_SESSION'),
    move_to_other_room: R('NO_ACTIVE_SESSION'),
    set_task: R('NO_ACTIVE_SESSION'),
    stale_set_task: R('NO_ACTIVE_SESSION'),
  },
  STUDYING: {
    start_in_room: R('SESSION_ALREADY_ACTIVE'), // row 13
    start_room_not_present: R('SESSION_ALREADY_ACTIVE'),
    start_solo: R('SESSION_ALREADY_ACTIVE'),
    start_solo_while_in_room: R('SESSION_ALREADY_ACTIVE'),
    break_5: N('ON_BREAK'), // row 2
    break_10: N('ON_BREAK'),
    break_15: N('ON_BREAK'),
    break_30: N('ON_BREAK'),
    ...allInvalid(R('VALIDATION_ERROR')),
    resume_in_room: R('NOT_ON_BREAK'), // row 16
    resume_not_in_room: R('NOT_ON_BREAK'),
    end: N('ENDED'), // row 5
    stale_break: R('STALE_SESSION'), // row 18
    stale_resume: R('STALE_SESSION'),
    stale_end: R('STALE_SESSION'),
    move_to_other_room: R('SESSION_IN_OTHER_ROOM'), // row 19
    set_task: N('STUDYING'), // row 12,
    stale_set_task: R('STALE_SESSION'),
  },
  ON_BREAK: {
    start_in_room: R('SESSION_ALREADY_ACTIVE'),
    start_room_not_present: R('SESSION_ALREADY_ACTIVE'),
    start_solo: R('SESSION_ALREADY_ACTIVE'),
    start_solo_while_in_room: R('SESSION_ALREADY_ACTIVE'),
    break_5: R('NOT_STUDYING'), // row 14
    break_10: R('NOT_STUDYING'),
    break_15: R('NOT_STUDYING'),
    break_30: R('NOT_STUDYING'),
    ...allInvalid(R('VALIDATION_ERROR')),
    resume_in_room: R('BREAK_NOT_OVER'), // row 15 — no early resume (R5, I-05)
    resume_not_in_room: R('BREAK_NOT_OVER'),
    end: N('ENDED'), // row 6
    stale_break: R('STALE_SESSION'),
    stale_resume: R('STALE_SESSION'),
    stale_end: R('STALE_SESSION'),
    move_to_other_room: R('SESSION_IN_OTHER_ROOM'),
    set_task: N('ON_BREAK'),
    stale_set_task: R('STALE_SESSION'),
  },
  BREAK_OVER: {
    start_in_room: R('SESSION_ALREADY_ACTIVE'),
    start_room_not_present: R('SESSION_ALREADY_ACTIVE'),
    start_solo: R('SESSION_ALREADY_ACTIVE'),
    start_solo_while_in_room: R('SESSION_ALREADY_ACTIVE'),
    break_5: R('NOT_STUDYING'), // row 14 (no chained breaks)
    break_10: R('NOT_STUDYING'),
    break_15: R('NOT_STUDYING'),
    break_30: R('NOT_STUDYING'),
    ...allInvalid(R('VALIDATION_ERROR')),
    resume_in_room: N('STUDYING'), // row 4 — manual resume
    resume_not_in_room: R('NOT_IN_SESSION_ROOM'), // row 21 (D-7)
    end: N('ENDED'), // row 6
    stale_break: R('STALE_SESSION'),
    stale_resume: R('STALE_SESSION'),
    stale_end: R('STALE_SESSION'),
    move_to_other_room: R('SESSION_IN_OTHER_ROOM'),
    set_task: N('BREAK_OVER'),
    stale_set_task: R('STALE_SESSION'),
  },
};

const fixtureNames = Object.keys(fixtures) as Fixture[];
const variantNames = Object.keys(variants) as VariantName[];

describe('timer machine — exhaustive transition table (Phase 0 rows)', () => {
  it('covers every phase × event pair', () => {
    for (const f of fixtureNames) {
      for (const v of variantNames) {
        expect(table[f][v], `${f} × ${v} has no expectation`).toBeDefined();
      }
    }
    expect(fixtureNames.length * variantNames.length).toBe(4 * 25);
  });

  for (const f of fixtureNames) {
    for (const v of variantNames) {
      const expectation = table[f][v];
      it(`${f} × ${v} → ${'next' in expectation ? expectation.next : expectation.reject}`, () => {
        const session = fixtures[f];
        expect(phaseOf(session, T)).toBe(f);
        const variant: Variant = variants[v];
        const ctx: DecideContext = {
          now: T,
          newSessionId: NEW_SID,
          userPresenceRoomId: null,
          callerRoomId: null,
          ...variant.ctx,
        };
        const result = decide(session, variant.command, ctx);
        if ('reject' in expectation) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe(expectation.reject);
        } else {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.event.toPhase).toBe(expectation.next);
            expect(phaseOf(result.next, T)).toBe(
              expectation.next === 'ENDED' ? 'NO_SESSION' : expectation.next,
            );
            if (result.next && session) expect(result.next.version).toBe(session.version + 1);
            if (result.next && !session) expect(result.next.version).toBe(1);
            // Every accepted transition is user-initiated in Phase 0.
            expect(result.event.actor).toBe('USER');
          }
        }
      });
    }
  }
});
