/** Focused timer-core tests (TESTING_STRATEGY §5.1). */
import { describe, expect, it } from 'vitest';
import { decide, phaseOf, type DecideContext, type SessionCore } from '../src';

const T = Date.parse('2026-11-01T10:00:00.000Z');
const MIN = 60_000;
const ROOM = '5e1f0d5a-0000-4000-8000-000000000001';
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';

const ctx = (now: number, room: string | null = ROOM): DecideContext => ({
  now,
  newSessionId: SID,
  userPresenceRoomId: room,
  callerRoomId: room,
});

const studying = (overrides: Partial<SessionCore> = {}): SessionCore => ({
  id: SID,
  roomId: ROOM,
  taskId: null,
  startedAt: T - 30 * MIN,
  currentSegmentStartedAt: T - 30 * MIN,
  currentBreak: null,
  version: 1,
  ...overrides,
});

describe('break ≠ study (R3)', () => {
  it('take_break closes the segment at the exact instant the break opens', () => {
    const r = decide(
      studying(),
      { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: 10 },
      ctx(T),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effects).toEqual([
      { type: 'CLOSE_SEGMENT', at: T, reason: 'BREAK' },
      { type: 'OPEN_BREAK', at: T, durationMinutes: 10, endsAt: T + 10 * MIN },
    ]);
    expect(r.next?.currentSegmentStartedAt).toBeNull();
    expect(r.next?.currentBreak).toEqual({
      durationMinutes: 10,
      startedAt: T,
      endsAt: T + 10 * MIN,
    });
  });

  it.each([5, 10, 15, 30] as const)('a %i-minute break ends exactly %i minutes later', (d) => {
    const r = decide(
      studying(),
      { type: 'TAKE_BREAK', sessionId: SID, durationMinutes: d },
      ctx(T),
    );
    expect(r.ok && r.next?.currentBreak?.endsAt).toBe(T + d * MIN);
  });
});

describe('no early and no automatic resume (R5, I-05)', () => {
  const onBreak = studying({
    currentSegmentStartedAt: null,
    currentBreak: { durationMinutes: 10, startedAt: T, endsAt: T + 10 * MIN },
    version: 2,
  });

  it('resume 1 ms before the countdown ends → BREAK_NOT_OVER (with breakEndsAt)', () => {
    const r = decide(onBreak, { type: 'RESUME', sessionId: SID }, ctx(T + 10 * MIN - 1));
    expect(r).toEqual({
      ok: false,
      code: 'BREAK_NOT_OVER',
      details: { breakEndsAt: T + 10 * MIN },
    });
  });

  it('resume exactly at the end of the countdown is allowed (E-02)', () => {
    const r = decide(onBreak, { type: 'RESUME', sessionId: SID }, ctx(T + 10 * MIN));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effects).toEqual([
      { type: 'CLOSE_BREAK', at: T + 10 * MIN, reason: 'RESUMED' },
      { type: 'OPEN_SEGMENT', at: T + 10 * MIN, roomId: ROOM },
    ]);
  });

  it('time passing alone never returns to STUDYING', () => {
    for (const offset of [0, 9 * MIN, 10 * MIN, 11 * MIN, 40 * MIN, 24 * 60 * MIN]) {
      expect(phaseOf(onBreak, T + offset)).not.toBe('STUDYING');
    }
  });

  it('phase boundaries: ON_BREAK until endsAt, BREAK_OVER from endsAt', () => {
    expect(phaseOf(onBreak, T + 10 * MIN - 1)).toBe('ON_BREAK');
    expect(phaseOf(onBreak, T + 10 * MIN)).toBe('BREAK_OVER');
    expect(phaseOf(onBreak, T + 40 * MIN)).toBe('BREAK_OVER'); // idle auto-save arrives in Phase 2
  });
});

describe('end study', () => {
  it('during a break closes the break (not a segment) at now', () => {
    const onBreak = studying({
      currentSegmentStartedAt: null,
      currentBreak: { durationMinutes: 15, startedAt: T, endsAt: T + 15 * MIN },
    });
    const r = decide(onBreak, { type: 'END', sessionId: SID }, ctx(T + 4 * MIN));
    expect(r.ok && r.effects).toEqual([
      { type: 'CLOSE_BREAK', at: T + 4 * MIN, reason: 'ENDED_BY_USER' },
      { type: 'END_SESSION', at: T + 4 * MIN, reason: 'USER' },
    ]);
    expect(r.ok && r.next).toBeNull();
  });
});

describe('solo session moving into a room (row 11)', () => {
  it('while studying: splits the segment at now with no gap', () => {
    const r = decide(
      studying({ roomId: null }),
      { type: 'MOVE_TO_ROOM', roomId: ROOM },
      ctx(T, null),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effects).toEqual([
      { type: 'CLOSE_SEGMENT', at: T, reason: 'ROOM_MOVE' },
      { type: 'OPEN_SEGMENT', at: T, roomId: ROOM },
      { type: 'SET_ROOM', roomId: ROOM },
    ]);
    expect(r.next).toMatchObject({ roomId: ROOM, currentSegmentStartedAt: T, version: 2 });
  });

  it('while on a break: keeps the break, only sets the room', () => {
    const solo = studying({
      roomId: null,
      currentSegmentStartedAt: null,
      currentBreak: { durationMinutes: 5, startedAt: T, endsAt: T + 5 * MIN },
    });
    const r = decide(solo, { type: 'MOVE_TO_ROOM', roomId: ROOM }, ctx(T + MIN, null));
    expect(r.ok && r.effects).toEqual([{ type: 'SET_ROOM', roomId: ROOM }]);
    expect(r.ok && r.next?.currentBreak).toEqual(solo.currentBreak);
  });
});

describe('start', () => {
  it('opens a session and a segment at now with version 1', () => {
    const r = decide(null, { type: 'START', roomId: ROOM }, ctx(T));
    expect(r.ok && r.next).toEqual({
      id: SID,
      roomId: ROOM,
      taskId: null,
      startedAt: T,
      currentSegmentStartedAt: T,
      currentBreak: null,
      version: 1,
    });
  });
});

describe('attach a task (row 12, F-29)', () => {
  const TASK = 'cccccccc-0000-4000-8000-000000000001';

  it('start can carry a task; set_task changes it in any phase without changing the phase', () => {
    const started = decide(null, { type: 'START', roomId: ROOM, taskId: TASK }, ctx(T));
    expect(started.ok && started.next?.taskId).toBe(TASK);
    expect(started.ok && started.effects[0]).toEqual({
      type: 'CREATE_SESSION',
      at: T,
      roomId: ROOM,
      taskId: TASK,
    });

    const onBreak = studying({
      currentSegmentStartedAt: null,
      currentBreak: { durationMinutes: 5, startedAt: T, endsAt: T + 5 * MIN },
      taskId: TASK,
      version: 2,
    });
    const cleared = decide(
      onBreak,
      { type: 'SET_TASK', sessionId: SID, taskId: null },
      ctx(T + MIN),
    );
    expect(cleared.ok && cleared.next).toMatchObject({
      taskId: null,
      version: 3,
      currentBreak: onBreak.currentBreak,
    });
    expect(cleared.ok && cleared.effects).toEqual([{ type: 'SET_TASK', taskId: null }]);
    expect(cleared.ok && cleared.event).toMatchObject({
      type: 'TASK_SET',
      fromPhase: 'ON_BREAK',
      toPhase: 'ON_BREAK',
    });
  });
});
