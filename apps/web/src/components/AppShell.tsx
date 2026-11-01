import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { formatCountdown, formatDuration } from '@studysync/shared';
import { useEffect, useState } from 'react';
import { maybeNotifyBreakOver } from '../lib/breakNotification';
import { serverClock } from '../lib/serverClock';
import { useNow } from '../lib/useNow';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/RealtimeProvider';

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'font-semibold text-indigo-700' : 'text-slate-600 hover:text-slate-900';

/**
 * Header, navigation, connection status, the "session saved" notice (F-40) and the
 * "Back to room — your session saves in m:ss" banner for room sessions (E-09, D-7).
 */
export function AppShell() {
  const { user, logout } = useAuth();
  const { connection, session, lastAutoSaved, dismissAutoSaved } = useRealtime();
  const now = useNow(1_000);

  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Break-end notification: checked every second (scheduled from break.endsAt) and on every
  // session push (confirmed by the server's BREAK_OVER). Display only; never resumes (R5).
  useEffect(() => {
    maybeNotifyBreakOver(session, serverClock.now());
  }, [session, now]);
  const location = useLocation();
  const roomPath = session?.roomId ? `/rooms/${session.roomId}` : null;
  const showRoomBanner = roomPath !== null && location.pathname !== roomPath;

  return (
    <div className="mx-auto max-w-2xl px-3 py-4 sm:px-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-label="Main">
          <span className="text-lg font-bold text-slate-900">StudySync</span>
          <NavLink to="/" end className={navClass}>
            Dashboard
          </NavLink>
          <NavLink to="/history" className={navClass}>
            History
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            Settings
          </NavLink>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span
            data-testid="connection"
            data-connection={connection}
            className={connection === 'connected' ? 'text-emerald-700' : 'text-amber-700'}
          >
            {connection === 'connected'
              ? '● Live'
              : connection === 'failed'
                ? '● Offline'
                : '● Reconnecting…'}
          </span>
          <span className="text-slate-500" data-testid="signed-in-as">
            {user?.name}
          </span>
          <button
            type="button"
            data-testid="logout"
            onClick={() => void logout()}
            className="text-slate-600 underline"
          >
            Log out
          </button>
        </div>
      </header>
      {(!online || connection === 'failed') && (
        <p
          role="status"
          data-testid="connection-banner"
          className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {online ? 'Can’t reach StudySync right now. Retrying…' : 'You are offline.'} Your timer
          keeps running on the server; a session saves only after 2 minutes away.
        </p>
      )}
      {lastAutoSaved && (
        <p
          role="status"
          data-testid="auto-saved-notice"
          className="mb-4 flex flex-wrap justify-between gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          <span>
            Your session was saved{' '}
            {lastAutoSaved.endReason === 'IDLE_TIMEOUT'
              ? 'after 30 minutes in Break Over'
              : 'after you were away for 2 minutes'}{' '}
            — studied {formatDuration(lastAutoSaved.studiedMs)}.
          </span>
          <span className="flex gap-3">
            <Link
              to={`/sessions/${lastAutoSaved.sessionId}`}
              onClick={dismissAutoSaved}
              className="underline"
            >
              View summary
            </Link>
            <button type="button" onClick={dismissAutoSaved} className="underline">
              Dismiss
            </button>
          </span>
        </p>
      )}
      {showRoomBanner && (
        <p
          data-testid="back-to-room"
          className="mb-4 rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-900"
        >
          <NavLink to={roomPath} className="font-semibold underline">
            Back to {session?.roomName}
          </NavLink>
          {session?.disconnectedAt && session.autoSaveAt ? (
            <>
              {' '}
              — your session saves in{' '}
              <span className="font-mono" data-testid="back-to-room-countdown">
                {formatCountdown(Math.max(0, Date.parse(session.autoSaveAt) - now))}
              </span>
            </>
          ) : (
            ' — your session lives in this room.'
          )}
        </p>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
