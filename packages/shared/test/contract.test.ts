/** Schemas and display helpers (R4, R14, F-32). */
import { describe, expect, it } from 'vitest';
import {
  BREAK_DURATIONS_MINUTES,
  breakRemainingMs,
  canResume,
  displayMemberStatus,
  displayPhase,
  elapsedStudyMs,
  formatCountdown,
  formatDuration,
  prototypeIdentitySchema,
  startStudySchema,
  takeBreakSchema,
  type MemberStatusDto,
} from '../src';

const UUID = '5e1f0d5a-0000-4000-8000-000000000001';

describe('break durations (R4)', () => {
  it('the canonical list is exactly 5, 10, 15, 30', () => {
    expect([...BREAK_DURATIONS_MINUTES]).toEqual([5, 10, 15, 30]);
  });

  it.each([5, 10, 15, 30])('accepts %i', (d) => {
    expect(
      takeBreakSchema.safeParse({ commandId: UUID, sessionId: UUID, durationMinutes: d }).success,
    ).toBe(true);
  });

  it.each([0, 1, 20, 25, 45, 60, -5, 7.5, '10', null, undefined])('rejects %s', (d) => {
    expect(
      takeBreakSchema.safeParse({ commandId: UUID, sessionId: UUID, durationMinutes: d }).success,
    ).toBe(false);
  });
});

describe('the client can never send time (R14)', () => {
  it.each(['startedAt', 'studyMs', 'endsAt', 'durationMs', 'now'])(
    'rejects an extra "%s" field',
    (field) => {
      expect(
        takeBreakSchema.safeParse({
          commandId: UUID,
          sessionId: UUID,
          durationMinutes: 10,
          [field]: 1,
        }).success,
      ).toBe(false);
      expect(
        startStudySchema.safeParse({ commandId: UUID, roomId: UUID, [field]: 1 }).success,
      ).toBe(false);
    },
  );

  it('requires UUIDs for ids', () => {
    expect(startStudySchema.safeParse({ commandId: 'x', roomId: UUID }).success).toBe(false);
  });
});

describe('prototype identity', () => {
  it('trims names and bounds their length', () => {
    expect(prototypeIdentitySchema.parse({ userId: UUID, name: '  Rahul ' }).name).toBe('Rahul');
    expect(prototypeIdentitySchema.safeParse({ userId: UUID, name: '   ' }).success).toBe(false);
    expect(prototypeIdentitySchema.safeParse({ userId: UUID, name: 'x'.repeat(51) }).success).toBe(
      false,
    );
    expect(prototypeIdentitySchema.safeParse({ userId: 'not-a-uuid', name: 'A' }).success).toBe(
      false,
    );
  });
});

describe('display helpers (render server timestamps; never decide)', () => {
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('elapsed = closed segments + running segment', () => {
    expect(
      elapsedStudyMs({ studyMsClosed: 600_000, currentSegmentStartedAt: iso(t0) }, t0 + 90_000),
    ).toBe(690_000);
    expect(
      elapsedStudyMs({ studyMsClosed: 600_000, currentSegmentStartedAt: null }, t0 + 90_000),
    ).toBe(600_000);
  });

  it('a skewed client clock cannot produce negative running time', () => {
    expect(elapsedStudyMs({ studyMsClosed: 0, currentSegmentStartedAt: iso(t0) }, t0 - 5_000)).toBe(
      0,
    );
  });

  it('countdown and phase flip at the end of the break, never to STUDYING', () => {
    const s = {
      phase: 'ON_BREAK' as const,
      break: { durationMinutes: 5 as const, startedAt: iso(t0), endsAt: iso(t0 + 300_000) },
    };
    expect(breakRemainingMs(s.break.endsAt, t0 + 299_000)).toBe(1_000);
    expect(displayPhase(s, t0 + 299_999)).toBe('ON_BREAK');
    expect(canResume(s, t0 + 299_999)).toBe(false);
    expect(displayPhase(s, t0 + 300_000)).toBe('BREAK_OVER');
    expect(canResume(s, t0 + 300_000)).toBe(true);
    expect(breakRemainingMs(s.break.endsAt, t0 + 999_999)).toBe(0);
    // Clamped to the break length when the start is known (client clock slightly behind).
    expect(breakRemainingMs(s.break.endsAt, t0 - 50, s.break.startedAt)).toBe(300_000);
  });

  it('a member whose countdown ended shows as Idle', () => {
    const m: MemberStatusDto = {
      user: { id: UUID, name: 'Rahul' },
      status: 'ON_BREAK',
      breakEndsAt: iso(t0),
      reconnecting: false,
      version: 1,
    };
    expect(displayMemberStatus(m, t0 - 1)).toBe('ON_BREAK');
    expect(displayMemberStatus(m, t0)).toBe('IDLE');
  });

  it('formats durations and countdowns', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(38 * 60_000 + 24_000)).toBe('38:24');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatCountdown(522_001)).toBe('08:42');
    expect(formatCountdown(300_004)).toBe('05:00'); // a client a few ms behind never shows 05:01
    expect(formatCountdown(0)).toBe('00:00');
  });
});
