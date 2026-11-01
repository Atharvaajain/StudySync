/**
 * Break-end browser notification (roadmap 4.3). Permission is asked only from a user gesture
 * (choosing a break length). The notification is scheduled from `break.endsAt` against the
 * corrected server clock and confirmed by the server's BREAK_OVER push; it is shown at most once
 * per break and only when the tab is hidden (the page itself shows "Break over" otherwise).
 * Clicking it focuses the app. It NEVER resumes the timer (R5): resuming is the user's click.
 */
import type { SessionDto } from '@studysync/shared';

const notified = new Set<string>();

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Call from a click handler (browsers only allow the prompt from a user gesture). */
export function requestBreakNotifications(): void {
  if (!notificationsSupported() || Notification.permission !== 'default') return;
  void Notification.requestPermission().catch(() => undefined);
}

/** Pure decision (unit-tested): notify for this break now? */
export function shouldNotifyBreakOver(input: {
  breakKey: string;
  endsAtMs: number;
  nowMs: number;
  permission: NotificationPermission | 'unsupported';
  hidden: boolean;
  alreadyNotified: boolean;
}): boolean {
  return (
    input.permission === 'granted' &&
    input.hidden &&
    !input.alreadyNotified &&
    input.nowMs >= input.endsAtMs
  );
}

/** Shows the notification for this session's break if it is due (idempotent per break). */
export function maybeNotifyBreakOver(session: SessionDto | null, nowMs: number): void {
  if (!session?.break || !notificationsSupported()) return;
  const breakKey = `${session.id}:${session.break.endsAt}`;
  const due = shouldNotifyBreakOver({
    breakKey,
    endsAtMs: Date.parse(session.break.endsAt),
    nowMs,
    permission: Notification.permission,
    hidden: document.visibilityState === 'hidden',
    alreadyNotified: notified.has(breakKey),
  });
  if (!due) return;
  notified.add(breakKey);
  const n = new Notification('Break over — StudySync', {
    body: 'Your timer is paused. Open StudySync and press Resume when you are ready.',
    tag: breakKey,
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
