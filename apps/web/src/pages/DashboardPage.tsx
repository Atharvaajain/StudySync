import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  PROTOTYPE_ROOM,
  type SessionSummaryDto,
  type StreakDto,
  type TodayDto,
} from '@studysync/shared';
import { SessionSummary } from '../components/SessionSummary';
import { StreakCard, TodayCard } from '../components/StatsCards';
import { TaskList } from '../components/TaskList';
import { TimerPanel } from '../components/TimerPanel';
import { Card, ErrorNote } from '../components/ui';
import { api } from '../lib/api';
import { useNow } from '../lib/useNow';
import { useRealtime } from '../realtime/RealtimeProvider';
import { useTasks } from '../realtime/useTasks';
import { useTimer } from '../realtime/useTimer';

const STATS_REFRESH_MS = 60_000;

/** Today, streak, refetched after every session change and every minute. */
function useDashboardStats() {
  const { revision } = useRealtime();
  const [today, setToday] = useState<TodayDto | null>(null);
  const [streak, setStreak] = useState<StreakDto | null>(null);
  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        api<TodayDto>('/stats/today'),
        api<StreakDto>('/stats/streak'),
      ]);
      setToday(t);
      setStreak(s);
    } catch {
      // keep the last values; the next refresh retries
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, revision]);
  useEffect(() => {
    const id = window.setInterval(() => void load(), STATS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);
  return { today, streak };
}

export function DashboardPage() {
  const now = useNow();
  const timer = useTimer();
  const tasks = useTasks();
  const { today, streak } = useDashboardStats();
  const [summary, setSummary] = useState<SessionSummaryDto | null>(null);
  const [startTaskId, setStartTaskId] = useState<string>('');
  const session = timer.session;
  const openTasks = tasks.tasks.filter((t) => t.status === 'TODO');

  const taskSlot =
    session === null ? (
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Working on
        <select
          data-testid="start-task"
          className="rounded-md border border-slate-300 px-2 py-1"
          value={startTaskId}
          onChange={(e) => setStartTaskId(e.target.value)}
        >
          <option value="">No task</option>
          {openTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Working on
        <select
          data-testid="session-task"
          className="rounded-md border border-slate-300 px-2 py-1"
          value={session.task?.id ?? ''}
          disabled={timer.pending}
          onChange={(e) => void timer.setTask(e.target.value || null)}
        >
          <option value="">No task</option>
          {session.task && !openTasks.some((t) => t.id === session.task?.id) && (
            <option value={session.task.id}>{session.task.title}</option>
          )}
          {openTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className="space-y-4">
      <ErrorNote message={timer.error} onDismiss={timer.clearError} />
      {summary && (
        <SessionSummary summary={summary} onDismiss={() => setSummary(null)} linkToDetails />
      )}
      <TimerPanel
        session={session}
        now={now}
        pending={timer.pending}
        onStart={() => {
          setSummary(null);
          void timer.start(null, startTaskId || null).then((s) => {
            if (s) setStartTaskId('');
          });
        }}
        onBreak={(minutes) => void timer.takeBreak(minutes)}
        onResume={() => void timer.resume()}
        onEnd={() => void timer.end().then((s) => s && setSummary(s))}
        taskSlot={taskSlot}
        note={
          session?.roomId ? (
            <span data-testid="room-session-note">
              This session lives in{' '}
              <Link to={`/rooms/${session.roomId}`} className="underline">
                {session.roomName}
              </Link>
              . Resume it from the room.
            </span>
          ) : (
            'Solo session. Your study time is always yours.'
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TodayCard today={today} session={session} now={now} />
        <StreakCard streak={streak} />
      </div>
      <TaskList
        tasks={tasks.tasks}
        error={tasks.error}
        onDismissError={tasks.clearError}
        onAdd={tasks.add}
        onToggle={tasks.toggle}
        onUpdate={tasks.update}
        onDelete={tasks.remove}
      />
      <Card title="Rooms">
        <p className="text-sm text-slate-600">
          Study next to others — everyone keeps their own timer.{' '}
          <Link
            to={`/rooms/${PROTOTYPE_ROOM.id}`}
            data-testid="open-room"
            className="font-semibold text-indigo-700 underline"
          >
            Open {PROTOTYPE_ROOM.name}
          </Link>
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Creating and joining your own rooms arrives in the next phase.
        </p>
      </Card>
    </div>
  );
}
