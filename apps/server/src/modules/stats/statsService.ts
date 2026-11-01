/**
 * Daily totals and streaks, computed from study segments only (R3: break time never counts;
 * I-11: nothing is stored). One aggregation engine in SQL (DATABASE_DESIGN §6.1, §6.2):
 * every segment is split at the local midnights of ITS OWN timezone snapshot (D-6), so a
 * timezone change never rewrites past days. "Today" and range bounds use the user's CURRENT
 * timezone.
 *
 * All instants come from the injected Clock; SQL now() is never used. Casts of calendar dates
 * to instants are pinned to UTC so the result never depends on the session timezone.
 */
import {
  STATS_MAX_RANGE_DAYS,
  STREAK_MIN_STUDY_MS,
  addDays,
  daysBetween,
  localDateOf,
  type DailyStatsDto,
  type StreakDto,
  type TodayDto,
} from '@studysync/shared';
import type { Clock } from '../../lib/clock';
import { Prisma, toDate, type Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toIso } from '../../lib/time';

export interface DayTotal {
  date: string;
  soloMs: number;
  roomsMs: number;
  totalMs: number;
}

/** §6.1 `seg` + `pieces` CTEs: segments (running ones end at $now) split at local midnights. */
function piecesCte(userId: string, now: Date, range: { from: string; to: string } | null) {
  const window = range
    ? Prisma.sql`
        AND s.started_at < ((${range.to}::date + 2)::timestamp AT TIME ZONE 'UTC')
        AND COALESCE(s.ended_at, ${now}::timestamptz) > ((${range.from}::date - 1)::timestamp AT TIME ZONE 'UTC')`
    : Prisma.empty;
  return Prisma.sql`
    seg AS (
      SELECT s.room_id, s.timezone AS tz, s.started_at, COALESCE(s.ended_at, ${now}::timestamptz) AS ended_at
      FROM study_segments s
      WHERE s.user_id = ${userId}::uuid ${window}
    ),
    pieces AS (
      SELECT seg.room_id,
             d.local_day::date AS local_date,
             GREATEST(seg.started_at, d.local_day AT TIME ZONE seg.tz)                 AS p_start,
             LEAST(seg.ended_at, (d.local_day + interval '1 day') AT TIME ZONE seg.tz) AS p_end
      FROM seg
      CROSS JOIN LATERAL generate_series(
          date_trunc('day', seg.started_at AT TIME ZONE seg.tz),
          date_trunc('day', seg.ended_at   AT TIME ZONE seg.tz),
          interval '1 day') AS d(local_day)
    )`;
}

export class StatsService {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  /** Per local day totals for [from, to] (only days with study; see `daily` for zero-fill). */
  async dayTotals(userId: string, from: string, to: string): Promise<DayTotal[]> {
    const now = toDate(this.deps.clock.now());
    const rows = await this.deps.db.$queryRaw<
      { local_date: string; total_ms: bigint; solo_ms: bigint; rooms_ms: bigint }[]
    >`
      WITH ${piecesCte(userId, now, { from, to })}
      SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date,
             SUM(EXTRACT(EPOCH FROM p_end - p_start) * 1000)::bigint AS total_ms,
             COALESCE(SUM(EXTRACT(EPOCH FROM p_end - p_start) * 1000) FILTER (WHERE room_id IS NULL), 0)::bigint     AS solo_ms,
             COALESCE(SUM(EXTRACT(EPOCH FROM p_end - p_start) * 1000) FILTER (WHERE room_id IS NOT NULL), 0)::bigint AS rooms_ms
      FROM pieces
      WHERE p_end > p_start AND local_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY local_date
      ORDER BY local_date`;
    return rows.map((r) => ({
      date: r.local_date,
      soloMs: Number(r.solo_ms),
      roomsMs: Number(r.rooms_ms),
      totalMs: Number(r.total_ms),
    }));
  }

  /** GET /stats/today: Solo / Rooms / Total for the current local day, running segment included. */
  async today(userId: string): Promise<TodayDto> {
    const timezone = await this.timezoneOf(userId);
    const now = this.deps.clock.now();
    const localDate = localDateOf(now, timezone);
    const [day] = await this.dayTotals(userId, localDate, localDate);
    const totalMs = day?.totalMs ?? 0;
    return {
      localDate,
      timezone,
      soloMs: day?.soloMs ?? 0,
      roomsMs: day?.roomsMs ?? 0,
      totalMs,
      thresholdMs: STREAK_MIN_STUDY_MS,
      qualified: totalMs >= STREAK_MIN_STUDY_MS,
      serverNow: toIso(now),
    };
  }

  /** GET /stats/daily: zero-filled per-day totals, at most 366 days. */
  async daily(userId: string, from: string, to: string): Promise<DailyStatsDto> {
    const span = daysBetween(from, to);
    if (span < 0 || span + 1 > STATS_MAX_RANGE_DAYS) {
      throw new AppError('VALIDATION_ERROR', {
        reason: `from must be ≤ to and the range at most ${STATS_MAX_RANGE_DAYS} days`,
      });
    }
    const timezone = await this.timezoneOf(userId);
    const byDate = new Map((await this.dayTotals(userId, from, to)).map((d) => [d.date, d]));
    const days: DailyStatsDto['days'] = [];
    for (let i = 0; i <= span; i++) {
      const date = addDays(from, i);
      const d = byDate.get(date);
      const totalMs = d?.totalMs ?? 0;
      days.push({
        date,
        soloMs: d?.soloMs ?? 0,
        roomsMs: d?.roomsMs ?? 0,
        totalMs,
        qualified: totalMs >= STREAK_MIN_STUDY_MS,
      });
    }
    return { timezone, days };
  }

  /**
   * GET /stats/streak (§6.2): consecutive local days with ≥ 25 min of recorded study, from
   * history. The current streak survives until the end of today: if yesterday qualified and
   * today not yet, it is shown "at risk".
   */
  async streak(userId: string): Promise<StreakDto> {
    const timezone = await this.timezoneOf(userId);
    const nowMs = this.deps.clock.now();
    const now = toDate(nowMs);
    const runs = await this.deps.db.$queryRaw<
      { run_start: string; run_end: string; run_length: number }[]
    >`
      WITH ${piecesCte(userId, now, null)},
      daily AS (
        SELECT local_date, SUM(EXTRACT(EPOCH FROM p_end - p_start) * 1000) AS total_ms
        FROM pieces WHERE p_end > p_start GROUP BY local_date
      ),
      qualified AS (SELECT local_date FROM daily WHERE total_ms >= ${STREAK_MIN_STUDY_MS}),
      islands AS (
        SELECT local_date, local_date - (ROW_NUMBER() OVER (ORDER BY local_date))::int AS grp
        FROM qualified
      )
      SELECT to_char(MIN(local_date), 'YYYY-MM-DD') AS run_start,
             to_char(MAX(local_date), 'YYYY-MM-DD') AS run_end,
             COUNT(*)::int AS run_length
      FROM islands GROUP BY grp ORDER BY MAX(local_date) DESC`;

    const today = localDateOf(nowMs, timezone);
    const yesterday = addDays(today, -1);
    const [todayTotal] = await this.dayTotals(userId, today, today);
    const todayMs = todayTotal?.totalMs ?? 0;
    const todayQualified = todayMs >= STREAK_MIN_STUDY_MS;

    const latest = runs[0];
    const alive = latest !== undefined && latest.run_end >= yesterday;
    return {
      current: alive ? latest.run_length : 0,
      longest: runs.reduce((max, r) => Math.max(max, r.run_length), 0),
      currentStart: alive ? latest.run_start : null,
      lastQualifiedDate: latest?.run_end ?? null,
      todayQualified,
      todayMs,
      thresholdMs: STREAK_MIN_STUDY_MS,
      atRisk: alive && !todayQualified && latest.run_end === yesterday,
    };
  }

  private async timezoneOf(userId: string): Promise<string> {
    const user = await this.deps.db.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    if (!user) throw new AppError('NOT_FOUND');
    return user.timezone;
  }
}
