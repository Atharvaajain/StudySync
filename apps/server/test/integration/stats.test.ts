/**
 * INT-ACC (daily totals, the DATABASE_DESIGN §6.1 matrix, timezone snapshot D-6) and
 * INT-STATS (today, daily zero-fill and range caps, streak computed from history, I-11).
 * Sessions are created through the real SessionService with a controlled clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DailyStatsDto, StreakDto, TodayDto } from '@studysync/shared';
import { audit, createUser, testDb } from '../helpers/db';
import { MIN, startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';
import { breakFor, endSession, soloSession, startSolo } from '../helpers/sessions';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

const H = 60 * MIN;

async function user(timezone: string): Promise<string> {
  return (await createUser(testDb(), { timezone })).id;
}

async function daily(userId: string, from: string, to: string): Promise<DailyStatsDto> {
  const res = await api(h)
    .get(`/api/v1/stats/daily?from=${from}&to=${to}`)
    .set(...bearer(h.tokenFor(userId)));
  if (res.status !== 200) throw new Error(`${res.status} ${res.text}`);
  return res.body as DailyStatsDto;
}

const minutes = (d: DailyStatsDto) => d.days.map((x) => [x.date, x.totalMs / MIN]);

describe('INT-ACC midnight and DST splitting (§6.1 matrix)', () => {
  it.each([
    {
      name: 'Asia/Kolkata 23:30–00:30',
      tz: 'Asia/Kolkata',
      start: '2026-10-31T18:00:00Z',
      ms: H,
      range: ['2026-10-31', '2026-11-01'],
      expected: [
        ['2026-10-31', 30],
        ['2026-11-01', 30],
      ],
    },
    {
      name: 'America/New_York 26.5 h across fall-back (25-hour day)',
      tz: 'America/New_York',
      start: '2026-11-01T03:00:00Z',
      ms: 26.5 * H,
      range: ['2026-10-31', '2026-11-02'],
      expected: [
        ['2026-10-31', 60],
        ['2026-11-01', 1500],
        ['2026-11-02', 30],
      ],
    },
    {
      name: 'America/New_York 25 h across spring-forward (23-hour day)',
      tz: 'America/New_York',
      start: '2026-03-08T04:00:00Z',
      ms: 25 * H,
      range: ['2026-03-07', '2026-03-09'],
      expected: [
        ['2026-03-07', 60],
        ['2026-03-08', 1380],
        ['2026-03-09', 60],
      ],
    },
    {
      name: 'America/Santiago: local midnight does not exist',
      tz: 'America/Santiago',
      start: '2026-09-06T03:30:00Z',
      ms: H,
      range: ['2026-09-05', '2026-09-06'],
      expected: [
        ['2026-09-05', 30],
        ['2026-09-06', 30],
      ],
    },
    {
      name: 'Australia/Lord_Howe 30-minute DST shift (24.5-hour day)',
      tz: 'Australia/Lord_Howe',
      start: '2026-04-04T12:00:00Z',
      ms: 26.5 * H,
      range: ['2026-04-04', '2026-04-06'],
      expected: [
        ['2026-04-04', 60],
        ['2026-04-05', 1470],
        ['2026-04-06', 60],
      ],
    },
    {
      name: 'segment ending exactly at local midnight → one piece',
      tz: 'UTC',
      start: '2026-10-31T23:00:00Z',
      ms: H,
      range: ['2026-10-31', '2026-11-01'],
      expected: [
        ['2026-10-31', 60],
        ['2026-11-01', 0],
      ],
    },
    {
      name: 'Pacific/Kiritimati (UTC+14)',
      tz: 'Pacific/Kiritimati',
      start: '2026-10-31T09:30:00Z',
      ms: H,
      range: ['2026-10-30', '2026-11-01'],
      expected: [
        ['2026-10-30', 0],
        ['2026-10-31', 30],
        ['2026-11-01', 30],
      ],
    },
    {
      name: 'Pacific/Pago_Pago (UTC−11), same instant',
      tz: 'Pacific/Pago_Pago',
      start: '2026-10-31T09:30:00Z',
      ms: H,
      range: ['2026-10-30', '2026-11-01'],
      expected: [
        ['2026-10-30', 60],
        ['2026-10-31', 0],
        ['2026-11-01', 0],
      ],
    },
  ])('$name', async ({ tz, start, ms, range, expected }) => {
    const id = await user(tz);
    await soloSession(h, id, start, ms);
    const result = await daily(id, range[0]!, range[1]!);
    expect(result.timezone).toBe(tz);
    expect(minutes(result)).toEqual(expected);
    // Conservation of total time.
    expect(result.days.reduce((s, d) => s + d.totalMs, 0)).toBe(ms);
    expect(result.days.every((d) => d.roomsMs === 0 && d.soloMs === d.totalMs)).toBe(true);
  });
});

describe('INT-ACC accounting rules', () => {
  it('R3: break time never counts; sessions of one day add up; running segments are included', async () => {
    const id = await user('UTC');
    h.clock.set(Date.parse('2026-11-01T08:00:00Z'));
    const s = await startSolo(h, id);
    h.clock.advance(20 * MIN);
    await breakFor(h, id, s.id, 15);
    h.clock.advance(10 * MIN);
    await endSession(h, id, s.id);
    h.clock.set(Date.parse('2026-11-01T12:00:00Z'));
    await startSolo(h, id); // still running
    h.clock.advance(7 * MIN);

    const today = (
      await api(h)
        .get('/api/v1/stats/today')
        .set(...bearer(h.tokenFor(id)))
    ).body as TodayDto;
    expect(today).toEqual({
      localDate: '2026-11-01',
      timezone: 'UTC',
      soloMs: 37 * MIN,
      roomsMs: 0,
      totalMs: 37 * MIN,
      thresholdMs: 25 * MIN,
      qualified: true,
      serverNow: '2026-11-01T12:07:00.000Z',
    });
  });

  it('D-6: a timezone change never rewrites history; the running segment keeps its snapshot', async () => {
    const id = await user('Asia/Kolkata');
    await soloSession(h, id, '2026-10-31T18:00:00Z', H); // 23:30–00:30 IST
    const before = await daily(id, '2026-10-30', '2026-11-01');

    // A segment starts in Kolkata at 02:00 IST on 11-02, then the user moves to New York.
    h.clock.set(Date.parse('2026-11-01T20:30:00Z'));
    const s = await startSolo(h, id);
    h.clock.advance(30 * MIN);
    const patched = await api(h)
      .patch('/api/v1/users/me')
      .set(...bearer(h.tokenFor(id)))
      .send({ timezone: 'America/New_York' });
    expect(patched.status).toBe(200);
    h.clock.advance(30 * MIN);
    await breakFor(h, id, s.id, 5); // the next segment snapshots the NEW zone
    h.clock.advance(20 * MIN);
    await endSession(h, id, s.id);

    const segments = await testDb().studySegment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
    });
    expect(segments.map((g) => g.timezone)).toEqual(['Asia/Kolkata', 'America/New_York']);

    // History through 11-01 is unchanged, even though the range is now read in New York time.
    const after = await daily(id, '2026-10-30', '2026-11-01');
    expect(after.timezone).toBe('America/New_York');
    expect(minutes(after)).toEqual([
      ['2026-10-30', 0],
      ['2026-10-31', 30],
      ['2026-11-01', 30 + 20], // 20 min from 21:35Z = 16:35 EST on 11-01 (new snapshot)
    ]);
    expect(minutes(before)).toEqual([
      ['2026-10-30', 0],
      ['2026-10-31', 30],
      ['2026-11-01', 30],
    ]);
    // The 60-minute Kolkata segment stays on 11-02 IST.
    expect(minutes(await daily(id, '2026-11-02', '2026-11-02'))).toEqual([['2026-11-02', 60]]);
  });

  it('daily: zero-filled, at most 366 days, from ≤ to, valid dates only', async () => {
    const id = await user('UTC');
    const result = await daily(id, '2026-01-01', '2027-01-01'); // 366 days
    expect(result.days).toHaveLength(366);
    expect(result.days.every((d) => d.totalMs === 0 && !d.qualified)).toBe(true);
    const get = (q: string) =>
      api(h)
        .get(`/api/v1/stats/daily?${q}`)
        .set(...bearer(h.tokenFor(id)));
    for (const q of [
      'from=2026-01-01&to=2027-01-02',
      'from=2026-11-02&to=2026-11-01',
      'from=2026-02-30&to=2026-03-01',
      'from=2026-11-01',
      'from=2026-11-01&to=2026-11-02&extra=1',
    ]) {
      expect((await get(q)).status, q).toBe(400);
    }
  });
});

describe('INT-STATS streak (R11: ≥ 25 min per local day, computed from history)', () => {
  async function streak(id: string): Promise<StreakDto> {
    return (
      await api(h)
        .get('/api/v1/stats/streak')
        .set(...bearer(h.tokenFor(id)))
    ).body as StreakDto;
  }

  it('counts consecutive qualified days, is "at risk" until today qualifies, and resets on a gap', async () => {
    const id = await user('Asia/Kolkata');
    // 25 min on 10-28, 10-29, 10-30 and 24:59 on 10-26 (does not qualify), local IST days.
    await soloSession(h, id, '2026-10-26T04:30:00Z', 25 * MIN - 1_000);
    for (const day of ['2026-10-28', '2026-10-29', '2026-10-30']) {
      await soloSession(h, id, `${day}T04:30:00Z`, 25 * MIN);
    }
    // Two sessions on 10-31 that only qualify together (15 + 10).
    await soloSession(h, id, '2026-10-31T04:30:00Z', 15 * MIN);
    await soloSession(h, id, '2026-10-31T06:30:00Z', 10 * MIN);

    h.clock.set(Date.parse('2026-11-01T05:00:00Z')); // 10:30 IST on 11-01
    expect(await streak(id)).toEqual({
      current: 4,
      longest: 4,
      currentStart: '2026-10-28',
      lastQualifiedDate: '2026-10-31',
      todayQualified: false,
      todayMs: 0,
      thresholdMs: 25 * MIN,
      atRisk: true,
    });

    await soloSession(h, id, '2026-11-01T05:00:00Z', 25 * MIN);
    expect(await streak(id)).toMatchObject({ current: 5, todayQualified: true, atRisk: false });

    // Two days later without study: the streak is broken; the longest is kept.
    h.clock.set(Date.parse('2026-11-03T05:00:00Z'));
    expect(await streak(id)).toMatchObject({
      current: 0,
      longest: 5,
      currentStart: null,
      lastQualifiedDate: '2026-11-01',
      atRisk: false,
    });
  });

  it('a running segment counts towards today (Kolkata 23:30–00:30 gives two half days)', async () => {
    const id = await user('Asia/Kolkata');
    h.clock.set(Date.parse('2026-10-31T18:00:00Z'));
    await startSolo(h, id);
    h.clock.advance(H);
    // 30 min on 10-31 and 30 min (still running) on 11-01: both days qualify.
    expect(await streak(id)).toMatchObject({
      current: 2,
      currentStart: '2026-10-31',
      todayMs: 30 * MIN,
      todayQualified: true,
    });
  });
});
