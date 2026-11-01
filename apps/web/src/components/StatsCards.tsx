import type { SessionDto, StreakDto, TodayDto } from '@studysync/shared';
import { Card, formatTotal } from './ui';

/** Running study time not yet included in a fetched total (counted live, display only). */
function liveExtraMs(session: SessionDto | null, fetchedServerNow: string, now: number): number {
  if (!session || session.phase !== 'STUDYING' || !session.currentSegmentStartedAt) return 0;
  const from = Math.max(Date.parse(fetchedServerNow), Date.parse(session.currentSegmentStartedAt));
  return Math.max(0, now - from);
}

/** TODAY: Solo / Rooms / Total in the user's timezone (F-10, F-33). Breaks never count. */
export function TodayCard({
  today,
  session,
  now,
}: {
  today: TodayDto | null;
  session: SessionDto | null;
  now: number;
}) {
  if (!today) {
    return (
      <Card title="Today" testId="today">
        <p className="text-sm text-slate-500">Loading…</p>
      </Card>
    );
  }
  const extra = liveExtraMs(session, today.serverNow, now);
  const soloMs = today.soloMs + (session?.roomId === null ? extra : 0);
  const roomsMs = today.roomsMs + (session?.roomId ? extra : 0);
  const totalMs = today.totalMs + extra;
  return (
    <Card title={`Today · ${today.localDate}`} testId="today">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Solo', soloMs, 'today-solo'],
          ['Rooms', roomsMs, 'today-rooms'],
          ['Total', totalMs, 'today-total'],
        ].map(([label, ms, id]) => (
          <div key={label as string} className="rounded-md bg-slate-50 p-2">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="font-mono text-lg font-semibold text-slate-900" data-testid={id}>
              {formatTotal(ms as number)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Days follow your timezone ({today.timezone}). 25 minutes of study keeps your streak.
      </p>
    </Card>
  );
}

/** Streak: consecutive local days with ≥ 25 min, computed from history (F-36, F-37). */
export function StreakCard({ streak }: { streak: StreakDto | null }) {
  return (
    <Card title="Streak" testId="streak">
      {!streak ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-3xl font-bold text-slate-900">
            <span data-testid="streak-current">{streak.current}</span>{' '}
            <span className="text-base font-normal text-slate-500">
              day{streak.current === 1 ? '' : 's'} 🔥
            </span>
          </p>
          <p className="text-right text-xs text-slate-500">
            Longest: <span data-testid="streak-longest">{streak.longest}</span>
            <br />
            {streak.todayQualified
              ? 'Today counts ✓'
              : streak.atRisk
                ? `Study ${formatTotal(streak.thresholdMs - streak.todayMs)} more today to keep it`
                : `${formatTotal(streak.thresholdMs - streak.todayMs)} more today to count`}
          </p>
        </div>
      )}
    </Card>
  );
}
