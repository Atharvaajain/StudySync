/**
 * Timer and timezone verification (ARCHITECTURE §14, risk T2; TESTING_STRATEGY P10/P11):
 *   1. SQL ↔ Intl cross-check: for random segments in DST-heavy zones, the per-day split done
 *      by PostgreSQL (`AT TIME ZONE`) equals an independent split computed with the runtime's
 *      Intl data (the engine the browser uses for "today").
 *   2. Session-timezone independence: a database connection whose session timezone is not UTC
 *      (a misconfigured managed database) returns exactly the same totals, heatmap and streak.
 *   3. Periods and heatmap (§6.11–§6.12): they match /stats/daily, conserve total time and
 *      respect the 366-day cap.
 */
import fc from 'fast-check';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STREAK_MIN_STUDY_MS, addDays, localDateOf } from '@studysync/shared';
import { createPrisma } from '../../src/lib/db';
import { StatsService } from '../../src/modules/stats/statsService';
import { TEST_DATABASE_URL, audit, createUser, testDb } from '../helpers/db';
import { MIN, startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';
import { soloSession } from '../helpers/sessions';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

const H = 60 * MIN;
const ZONES = [
  'America/New_York',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Europe/London',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'UTC',
];
/** 2026 DST days ± a few days, plus ordinary days. */
const ANCHORS = [
  '2026-03-08',
  '2026-11-01',
  '2026-04-05',
  '2026-09-06',
  '2026-10-25',
  '2026-06-15',
];

/** Independent per-local-day split using Intl only (binary search for each local midnight). */
function intlSplit(startMs: number, endMs: number, tz: string): Map<string, number> {
  const out = new Map<string, number>();
  let t = startMs;
  while (t < endMs) {
    const day = localDateOf(t, tz);
    let lo = t;
    let hi = Math.min(endMs, t + 50 * H);
    if (localDateOf(hi, tz) === day) {
      out.set(day, (out.get(day) ?? 0) + (hi - t));
      t = hi;
      continue;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDateOf(mid, tz) === day) lo = mid;
      else hi = mid;
    }
    out.set(day, (out.get(day) ?? 0) + (hi - t));
    t = hi;
  }
  return out;
}

describe('SQL ↔ Intl cross-check (risk T2)', () => {
  it('PostgreSQL and Intl split random segments into identical local days', async () => {
    const stats = h.server.stats;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ZONES),
        fc.constantFrom(...ANCHORS),
        fc.integer({ min: -36 * 60, max: 36 * 60 }), // start offset from the anchor, minutes
        fc.integer({ min: 1, max: 40 * 60 }), // duration, minutes
        async (tz, anchor, offsetMin, durationMin) => {
          const userId = (await createUser(testDb(), { timezone: tz })).id;
          const start = Date.parse(`${anchor}T12:00:00Z`) + offsetMin * MIN;
          const end = start + durationMin * MIN;
          await soloSession(h, userId, new Date(start).toISOString(), end - start);
          const expected = intlSplit(start, end, tz);
          const from = addDays([...expected.keys()].sort()[0]!, -1);
          const to = addDays([...expected.keys()].sort().at(-1)!, 1);
          const actual = new Map(
            (await stats.dayTotals(userId, from, to)).map((d) => [d.date, d.totalMs]),
          );
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: Number(process.env.TZ_RUNS ?? 40) },
    );
  });
});

describe('session-timezone independence', () => {
  const tokyoDb = createPrisma(`${TEST_DATABASE_URL}&options=-c%20TimeZone%3DAsia%2FTokyo`);
  afterAll(async () => {
    await tokyoDb.$disconnect();
  });

  it('a non-UTC database session gives the same daily totals, heatmap and streak', async () => {
    const [session] = await tokyoDb.$queryRaw<
      { tz: string }[]
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(session!.tz).toBe('Asia/Tokyo');
    const ny = (await createUser(testDb(), { timezone: 'America/New_York' })).id;
    await soloSession(h, ny, '2026-11-01T03:00:00Z', 26.5 * H); // across the fall-back day
    await soloSession(h, ny, '2026-11-03T02:00:00Z', 30 * MIN);
    const utcStats = h.server.stats;
    const tokyoStats = new StatsService({ db: tokyoDb, clock: h.clock });
    expect(await tokyoStats.daily(ny, '2026-10-30', '2026-11-04')).toEqual(
      await utcStats.daily(ny, '2026-10-30', '2026-11-04'),
    );
    expect(await tokyoStats.heatmap(ny, '2026-10-30', '2026-11-04')).toEqual(
      await utcStats.heatmap(ny, '2026-10-30', '2026-11-04'),
    );
    h.clock.set(Date.parse('2026-11-03T15:00:00Z'));
    expect(await tokyoStats.streak(ny)).toEqual(await utcStats.streak(ny));
  });
});

describe('periods and heatmap (§6.11, §6.12)', () => {
  it('weekly and monthly totals equal the sum of /stats/daily; zero-filled; qualified days', async () => {
    const id = (await createUser(testDb(), { timezone: 'Asia/Kolkata' })).id;
    const token = h.tokenFor(id);
    // Mon 2026-10-26 … Sun 11-01 and Mon 11-02: 30 min each on three days, 10 min on one.
    for (const [day, min] of [
      ['2026-10-26', 30],
      ['2026-10-31', 30],
      ['2026-11-01', 10],
      ['2026-11-02', 30],
    ] as const) {
      await soloSession(h, id, `${day}T04:30:00Z`, min * MIN);
    }
    const weeks = await api(h)
      .get('/api/v1/stats/periods?granularity=week&from=2026-10-19&to=2026-11-08')
      .set(...bearer(token));
    expect(weeks.status).toBe(200);
    expect(
      weeks.body.periods.map((p: { start: string; totalMs: number; qualifiedDays: number }) => [
        p.start,
        p.totalMs / MIN,
        p.qualifiedDays,
      ]),
    ).toEqual([
      ['2026-10-19', 0, 0],
      ['2026-10-26', 70, 2],
      ['2026-11-02', 30, 1],
    ]);
    const months = await api(h)
      .get('/api/v1/stats/periods?granularity=month&from=2026-10-01&to=2026-11-30')
      .set(...bearer(token));
    expect(
      months.body.periods.map((p: { start: string; totalMs: number }) => [
        p.start,
        p.totalMs / MIN,
      ]),
    ).toEqual([
      ['2026-10-01', 60],
      ['2026-11-01', 40],
    ]);
    const bad = await api(h)
      .get('/api/v1/stats/periods?granularity=year&from=2026-10-01&to=2026-11-30')
      .set(...bearer(token));
    expect(bad.status).toBe(400);
  });

  it('heatmap: local weekday × hour of each segment’s own zone; total time conserved', async () => {
    const id = (await createUser(testDb(), { timezone: 'America/New_York' })).id;
    // Sat 2026-10-31 23:30 EDT → Sun 11-01 00:30 EDT, then a 26.5 h block across fall-back.
    await soloSession(h, id, '2026-11-01T03:30:00Z', H);
    await soloSession(h, id, '2026-11-02T04:00:00Z', 26.5 * H);
    const res = await api(h)
      .get('/api/v1/stats/heatmap?from=2026-10-25&to=2026-11-08')
      .set(...bearer(h.tokenFor(id)));
    expect(res.status).toBe(200);
    const cells = res.body.cells as { weekday: number; hour: number; studyMs: number }[];
    const at = (weekday: number, hour: number) =>
      cells.find((c) => c.weekday === weekday && c.hour === hour)?.studyMs ?? 0;
    expect(at(6, 23)).toBe(30 * MIN); // Saturday 23:00
    expect(at(7, 0)).toBe(30 * MIN); // Sunday 00:00
    const total = cells.reduce((s, c) => s + c.studyMs, 0);
    const daily = await h.server.stats.daily(id, '2026-10-25', '2026-11-08');
    expect(total).toBe(daily.days.reduce((s, d) => s + d.totalMs, 0));
    expect(total).toBe(H + 26.5 * H);
    expect(
      cells.every((c) => c.weekday >= 1 && c.weekday <= 7 && c.hour >= 0 && c.hour <= 23),
    ).toBe(true);
    const tooLong = await api(h)
      .get('/api/v1/stats/heatmap?from=2025-01-01&to=2026-11-08')
      .set(...bearer(h.tokenFor(id)));
    expect(tooLong.status).toBe(400);
  });

  it('streak threshold is exactly 25 minutes of recorded study (R11)', () => {
    expect(STREAK_MIN_STUDY_MS).toBe(25 * MIN);
  });
});
