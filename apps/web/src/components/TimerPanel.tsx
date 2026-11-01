import { useState, type ReactNode } from 'react';
import {
  breakRemainingMs,
  canResume,
  displayPhase,
  elapsedStudyMs,
  formatCountdown,
  formatDuration,
  type BreakMinutes,
  type SessionDto,
} from '@studysync/shared';
import { BreakPicker } from './BreakPicker';

interface Props {
  session: SessionDto | null;
  now: number;
  pending: boolean;
  onStart: () => void;
  onBreak: (minutes: BreakMinutes) => void;
  onResume: () => void;
  onEnd: () => void;
  /** Task line: picker before Start, "working on" during the session (F-29). */
  taskSlot?: ReactNode;
  /** Extra note under the controls (e.g. where the session lives). */
  note?: ReactNode;
}

const button =
  'rounded-md px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2';

/**
 * YOUR timer only. Every value is rendered from server timestamps (F-32):
 * elapsed = closed segments + (now − current segment start); countdown = break end − now.
 * Nothing here ever resumes the timer by itself (R5).
 */
export function TimerPanel({
  session,
  now,
  pending,
  onStart,
  onBreak,
  onResume,
  onEnd,
  taskSlot,
  note,
}: Props) {
  const [picking, setPicking] = useState(false);
  const phase = session ? displayPhase(session, now) : null;
  const elapsed = session ? elapsedStudyMs(session, now) : 0;

  return (
    <section aria-labelledby="timer-heading" className="rounded-lg bg-white p-4 shadow-sm">
      <h2
        id="timer-heading"
        className="text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Your timer
      </h2>

      <div className="mt-3 flex items-baseline justify-between gap-4">
        <p
          data-testid="elapsed"
          className={`font-mono text-5xl font-bold tabular-nums ${phase === 'STUDYING' ? 'text-slate-900' : 'text-slate-400'}`}
        >
          {formatDuration(elapsed)}
        </p>
        <p
          data-testid="timer-phase"
          data-phase={phase ?? 'NO_SESSION'}
          className="text-right text-sm font-semibold"
        >
          {phase === null && <span className="text-slate-500">⚪ Not studying</span>}
          {phase === 'STUDYING' && <span className="text-emerald-700">🟢 Studying</span>}
          {phase === 'ON_BREAK' && <span className="text-amber-700">🟡 On Break</span>}
          {phase === 'BREAK_OVER' && <span className="text-slate-700">⚪ Break over</span>}
        </p>
      </div>
      <p className="text-xs text-slate-500">Study time this session (breaks never count)</p>
      {taskSlot && <div className="mt-3">{taskSlot}</div>}

      {phase === 'ON_BREAK' && session?.break && (
        <div className="mt-4 rounded-md bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            Break ({session.break.durationMinutes} min) ends in{' '}
            <span
              data-testid="break-countdown"
              className="font-mono text-lg font-bold tabular-nums"
            >
              {formatCountdown(
                breakRemainingMs(session.break.endsAt, now, session.break.startedAt),
              )}
            </span>
          </p>
          <p className="mt-1 text-xs text-amber-800" data-testid="break-hint">
            Keep StudySync open during your break — closing it saves your session after 2 minutes.
            Resume becomes available when the countdown ends.
          </p>
        </div>
      )}

      {phase === 'BREAK_OVER' && (
        <p
          data-testid="break-over-banner"
          className="mt-4 rounded-md bg-slate-100 p-3 text-sm text-slate-800"
        >
          Break over — your timer is paused until you click <strong>Resume</strong>.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {session === null && (
          <button
            type="button"
            data-testid="start-study"
            disabled={pending}
            onClick={onStart}
            className={`${button} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300`}
          >
            Start Study
          </button>
        )}

        {phase === 'STUDYING' && !picking && (
          <button
            type="button"
            data-testid="take-break"
            disabled={pending}
            onClick={() => setPicking(true)}
            className={`${button} bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-300`}
          >
            Take Break
          </button>
        )}

        {(phase === 'ON_BREAK' || phase === 'BREAK_OVER') && (
          <button
            type="button"
            data-testid="resume-study"
            disabled={pending || !session || !canResume(session, now)}
            onClick={onResume}
            className={`${button} bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-300`}
          >
            Resume
          </button>
        )}

        {session !== null && (
          <button
            type="button"
            data-testid="end-study"
            disabled={pending}
            onClick={() => {
              setPicking(false);
              onEnd();
            }}
            className={`${button} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-300`}
          >
            End Study
          </button>
        )}
      </div>

      {note && <div className="mt-3 text-xs text-slate-500">{note}</div>}

      {phase === 'STUDYING' && picking && (
        <BreakPicker
          disabled={pending}
          onCancel={() => setPicking(false)}
          onPick={(minutes) => {
            setPicking(false);
            onBreak(minutes);
          }}
        />
      )}
    </section>
  );
}
