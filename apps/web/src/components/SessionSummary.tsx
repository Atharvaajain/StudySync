import { formatDuration, type SessionSummaryDto } from '@studysync/shared';

interface Props {
  summary: SessionSummaryDto;
  onDismiss: () => void;
}

/** End-of-session summary (F-39), computed by the server from segments and breaks. */
export function SessionSummary({ summary, onDismiss }: Props) {
  const breakMinutes = Math.round(summary.breaks.totalMs / 60_000);
  return (
    <section
      data-testid="session-summary"
      aria-labelledby="summary-heading"
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-4"
    >
      <h2 id="summary-heading" className="font-semibold text-emerald-900">
        Session complete
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
        <dd>{summary.where.roomName ?? 'Solo'}</dd>
      </dl>
      <button type="button" onClick={onDismiss} className="mt-3 text-sm text-emerald-800 underline">
        Dismiss
      </button>
    </section>
  );
}
