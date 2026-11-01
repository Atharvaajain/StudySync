/** Schemas and display helpers (R4, R14, F-32). */
import { describe, expect, it } from 'vitest';
import {
  canonicalTimeZone,
  BREAK_DURATIONS_MINUTES,
  breakRemainingMs,
  canResume,
  displayMemberStatus,
  displayPhase,
  elapsedStudyMs,
  formatCountdown,
  formatDuration,
  addDays,
  daysBetween,
  localDateOf,
  registerSchema,
  updateProfileSchema,
  utf8Bytes,
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

describe('account schemas (§17.1, §17.3)', () => {
  const base = {
    name: 'Atharva',
    email: 'Atharva@Example.com ',
    password: 'correct horse',
    timezone: 'Asia/Kolkata',
  };

  it('normalizes the email and trims the name', () => {
    const r = registerSchema.parse({ ...base, name: '  Atharva ' });
    expect(r).toMatchObject({ name: 'Atharva', email: 'atharva@example.com' });
  });

  it('passwords are 10–72 BYTES (bcrypt ignores bytes past 72)', () => {
    expect(registerSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: 'a'.repeat(72) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: 'a'.repeat(73) }).success).toBe(false);
    // 30 × "é" is 30 characters but 60 bytes (ok); 37 × "€" is 111 bytes (rejected).
    expect(registerSchema.safeParse({ ...base, password: 'é'.repeat(30) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: '€'.repeat(37) }).success).toBe(false);
    expect(utf8Bytes('a€😀')).toBe(1 + 3 + 4);
  });

  it('accepts IANA timezones only', () => {
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe']) {
      expect(registerSchema.safeParse({ ...base, timezone: tz }).success).toBe(true);
    }
    for (const tz of ['Mars/Olympus', 'GMT+99', '', 'x'.repeat(65)]) {
      expect(registerSchema.safeParse({ ...base, timezone: tz }).success).toBe(false);
    }
  });

  it('stores legacy browser zone ids under their current IANA name', () => {
    // Chrome reports India as Asia/Calcutta; PostgreSQL without tz backward links rejects it.
    const parsed = registerSchema.parse({ ...base, timezone: 'Asia/Calcutta' });
    expect(parsed.timezone).toBe('Asia/Kolkata');
    expect(updateProfileSchema.parse({ timezone: 'Europe/Kiev' }).timezone).toBe('Europe/Kyiv');
    expect(canonicalTimeZone('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(canonicalTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('profile updates need at least one field and reject unknown ones', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
    expect(updateProfileSchema.safeParse({ timezone: 'UTC' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ email: 'x@y.z' }).success).toBe(false);
  });
});

describe('local-date helpers', () => {
  it('resolve "today" per timezone and do calendar arithmetic', () => {
    const t = Date.parse('2026-10-31T19:00:00.000Z');
    expect(localDateOf(t, 'Asia/Kolkata')).toBe('2026-11-01'); // 00:30 IST
    expect(localDateOf(t, 'America/New_York')).toBe('2026-10-31');
    expect(localDateOf(t, 'Pacific/Kiritimati')).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3);
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
