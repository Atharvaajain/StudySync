import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  addDays,
  localDateOf,
  type DailyStatsDto,
  type SessionHistoryItem,
  type SessionHistoryPage,
} from '@studysync/shared';
import { useAuth } from '../auth/AuthContext';
import { Card, ErrorNote, formatTotal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { serverClock } from '../lib/serverClock';

const DAYS = 14;

/** F-41: per-day totals (in your timezone) and the session list → summary. */
export function HistoryPage() {
  const { user } = useAuth();
  const [daily, setDaily] = useState<DailyStatsDto | null>(null);
  const [items, setItems] = useState<SessionHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timezone = user?.timezone ?? 'UTC';
  useEffect(() => {
    const today = localDateOf(serverClock.now(), timezone);
    api<DailyStatsDto>(`/stats/daily?from=${addDays(today, -(DAYS - 1))}&to=${today}`)
      .then(setDaily)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [timezone]);

  const loadPage = useCallback(async (after: string | null) => {
    try {
      const page = await api<SessionHistoryPage>(
        `/sessions?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
      );
      setItems((current) => (after ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const maxMs = Math.max(1, ...(daily?.days.map((d) => d.totalMs) ?? [1]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">History</h1>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <Card title={`Last ${DAYS} days · ${daily?.timezone ?? timezone}`} testId="daily-totals">
        <ul className="space-y-1">
          {[...(daily?.days ?? [])].reverse().map((d) => (
            <li
              key={d.date}
              data-testid="day-row"
              data-date={d.date}
              data-total-ms={d.totalMs}
              className="grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-2 text-sm"
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

      <Card title="Sessions" testId="session-list">
        {items.length === 0 ? (
          <p className="text-sm text-slate-500">No sessions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((s) => (
              <li
                key={s.id}
                data-testid="session-row"
                className="flex justify-between py-2 text-sm"
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
