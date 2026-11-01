import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  addDays,
  localDateOf,
  periodStart,
  type DailyStatsDto,
  type HeatmapDto,
  type PeriodStatsDto,
  type SessionHistoryItem,
  type SessionHistoryPage,
} from '@studysync/shared';
import { useAuth } from '../auth/AuthContext';
import { Heatmap, PeriodChart } from '../components/StudyCharts';
import { Card, ErrorNote, Loading, formatTotal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { serverClock } from '../lib/serverClock';

const DAYS = 14;
const PERIODS = 12;
const HEATMAP_DAYS = 90;

/** Loads a stats endpoint; `null` while loading, with an error and a retry. */
function useStat<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  return { data, error, retry: load };
}

/**
 * F-41 + roadmap 3.2 / 4.1: per-day totals, weekly / monthly charts and the activity heatmap
 * (all in your timezone; break time never counts), and the session list → summaries.
 */
export function HistoryPage() {
  const { user } = useAuth();
  const timezone = user?.timezone ?? 'UTC';
  const today = localDateOf(serverClock.now(), timezone);
  const [granularity, setGranularity] = useState<'week' | 'month'>('week');

  const daily = useStat<DailyStatsDto>(
    `/stats/daily?from=${addDays(today, -(DAYS - 1))}&to=${today}`,
  );
  const periodFrom =
    granularity === 'week'
      ? addDays(periodStart(today, 'week'), -7 * (PERIODS - 1))
      : (() => {
          const [y, m] = today.split('-').map(Number) as [number, number];
          const back = new Date(Date.UTC(y, m - 1 - (PERIODS - 1), 1));
          return back.toISOString().slice(0, 10);
        })();
  const periods = useStat<PeriodStatsDto>(
    `/stats/periods?granularity=${granularity}&from=${periodFrom}&to=${today}`,
  );
  const heatmap = useStat<HeatmapDto>(
    `/stats/heatmap?from=${addDays(today, -(HEATMAP_DAYS - 1))}&to=${today}`,
  );

  const [items, setItems] = useState<SessionHistoryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const loadPage = useCallback(async (after: string | null) => {
    setListError(null);
    try {
      const page = await api<SessionHistoryPage>(
        `/sessions?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
      );
      setItems((current) => (after && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setListError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const maxMs = Math.max(1, ...(daily.data?.days.map((d) => d.totalMs) ?? [1]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">History</h1>

      <Card title={`Last ${DAYS} days · ${daily.data?.timezone ?? timezone}`} testId="daily-totals">
        <ErrorNote message={daily.error} onRetry={() => void daily.retry()} />
        {!daily.data && !daily.error && <Loading />}
        <ul className="space-y-1">
          {[...(daily.data?.days ?? [])].reverse().map((d) => (
            <li
              key={d.date}
              data-testid="day-row"
              data-date={d.date}
              data-total-ms={d.totalMs}
              className="grid grid-cols-[5.5rem_1fr_4rem] items-center gap-2 text-sm sm:grid-cols-[6.5rem_1fr_4.5rem]"
            >
              <span className="font-mono text-slate-600">{d.date}</span>
              <span className="h-3 rounded bg-slate-100" aria-hidden="true">
                <span
                  className={`block h-3 rounded ${d.qualified ? 'bg-emerald-500' : 'bg-indigo-300'}`}
                  style={{ width: `${(d.totalMs / maxMs) * 100}%` }}
                />
              </span>
              <span className="text-right font-mono text-slate-900">
                {formatTotal(d.totalMs)}
                {d.qualified ? ' ✓' : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          ✓ = at least 25 minutes (a streak day). Break time never counts.
        </p>
      </Card>

      <Card
        title={
          granularity === 'week'
            ? `Weekly · last ${PERIODS} weeks`
            : `Monthly · last ${PERIODS} months`
        }
        testId="period-chart"
        action={
          <div className="flex gap-1 text-xs" role="group" aria-label="Chart period">
            {(['week', 'month'] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={granularity === g}
                data-testid={`granularity-${g}`}
                onClick={() => setGranularity(g)}
                className={`rounded px-2 py-1 ${granularity === g ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                {g === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        }
      >
        <ErrorNote message={periods.error} onRetry={() => void periods.retry()} />
        {periods.data ? <PeriodChart data={periods.data} /> : !periods.error && <Loading />}
      </Card>

      <Card title={`When you study · last ${HEATMAP_DAYS} days`} testId="heatmap-card">
        <ErrorNote message={heatmap.error} onRetry={() => void heatmap.retry()} />
        {heatmap.data ? <Heatmap data={heatmap.data} /> : !heatmap.error && <Loading />}
      </Card>

      <Card title="Sessions" testId="session-list">
        <ErrorNote message={listError} onRetry={() => void loadPage(cursor)} />
        {items === null ? (
          !listError && <Loading />
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-500">
            No sessions yet. Start studying on the dashboard.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((s) => (
              <li
                key={s.id}
                data-testid="session-row"
                className="flex flex-wrap justify-between gap-x-3 py-2 text-sm"
              >
                <Link to={`/sessions/${s.id}`} className="text-indigo-700 underline">
                  {new Date(s.startedAt).toLocaleString(undefined, { timeZone: timezone })}
                </Link>
                <span className="text-slate-600">
                  {s.roomName ?? 'Solo'} · {formatTotal(s.studiedMs)}
                  {s.endedAt === null ? ' · in progress' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <button
            type="button"
            className="mt-2 text-sm text-indigo-700 underline"
            onClick={() => void loadPage(cursor)}
          >
            Load more
          </button>
        )}
      </Card>
    </div>
  );
}
