import { Link } from 'react-router';
import { formatDuration, type SessionSummaryDto } from '@studysync/shared';

interface Props {
  summary: SessionSummaryDto;
  onDismiss?: () => void;
  /** Show a link to the full summary page. */
  linkToDetails?: boolean;
}

const SAVED_BY = {
  USER: 'You',
  DISCONNECTED: 'Auto-saved after disconnect',
  IDLE_TIMEOUT: 'Auto-saved after 30 min idle',
} as const;

/** End-of-session summary (F-39, ARCHITECTURE §13.11), computed by the server. */
export function SessionSummary({ summary, onDismiss, linkToDetails = false }: Props) {
  const breakMinutes = Math.round(summary.breaks.totalMs / 60_000);
  const where = summary.where.roomName
    ? summary.where.movedFromSolo
      ? `Solo → ${summary.where.roomName}`
      : summary.where.roomName
    : 'Solo';
  return (
    <section
      data-testid="session-summary"
      aria-labelledby="summary-heading"
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-4"
    >
      <h2 id="summary-heading" className="font-semibold text-emerald-900">
        {summary.endedAt ? 'Session complete' : 'Session in progress'}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-emerald-900">
        <dt>Studied</dt>
        <dd data-testid="summary-studied" className="font-mono font-semibold">
          {formatDuration(summary.studiedMs)}
        </dd>
        <dt>Breaks</dt>
        <dd data-testid="summary-breaks">
          {summary.breaks.count} ({breakMinutes} min)
        </dd>
        <dt>Where</dt>
        <dd data-testid="summary-where">{where}</dd>
        <dt>Task</dt>
        <dd data-testid="summary-task">{summary.task?.title ?? '—'}</dd>
        <dt>Completed</dt>
        <dd data-testid="summary-completed">
          {summary.completedTasks.length === 0
            ? '—'
            : summary.completedTasks.map((t) => `✓ ${t.title}`).join(', ')}
        </dd>
        {summary.endReason && (
          <>
            <dt>Saved by</dt>
            <dd>{SAVED_BY[summary.endReason]}</dd>
          </>
        )}
      </dl>
      <div className="mt-3 flex gap-4 text-sm">
        {linkToDetails && (
          <Link to={`/sessions/${summary.id}`} className="text-emerald-800 underline">
            Details
          </Link>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-emerald-800 underline">
            Dismiss
          </button>
        )}
      </div>
    </section>
  );
}
