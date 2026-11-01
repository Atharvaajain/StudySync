/** Small shared UI pieces (kept deliberately minimal). */
import type { ReactNode } from 'react';

export const buttonClass =
  'rounded-md px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2';
export const primaryButton = `${buttonClass} bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-300`;
export const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export function Card({
  title,
  children,
  testId,
  action,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg bg-white p-4 shadow-sm" data-testid={testId}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function ErrorNote({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="error"
      className="flex justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="underline">
          Dismiss
        </button>
      )}
    </p>
  );
}

/** "1h 25m" for totals (minutes resolution). */
export function formatTotal(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
