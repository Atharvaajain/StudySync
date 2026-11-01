/** Small shared UI pieces (kept deliberately minimal). */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export const buttonClass =
  'rounded-md px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2';
export const primaryButton = `${buttonClass} bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-300`;
export const inputClass =
  'w-full min-w-0 rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
  onRetry,
}: {
  message: string | null;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="error"
      className="flex flex-wrap justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      <span>{message}</span>
      <span className="flex gap-3">
        {onRetry && (
          <button type="button" onClick={onRetry} className="underline">
            Try again
          </button>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="underline">
            Dismiss
          </button>
        )}
      </span>
    </p>
  );
}

/** A consistent, accessible loading indicator. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p
      role="status"
      aria-busy="true"
      data-testid="loading"
      className="flex items-center gap-2 text-sm text-slate-500"
    >
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600"
      />
      {label}
    </p>
  );
}

/** Last line of defense for unexpected render errors: a readable message and a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('StudySync UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-md space-y-3 p-8 text-center">
        <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
        <p className="text-sm text-slate-600">
          Your study timer is safe — it runs on the server. Reload the page to continue.
        </p>
        <button type="button" className={primaryButton} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/** "1h 25m" for totals (minutes resolution). */
export function formatTotal(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
