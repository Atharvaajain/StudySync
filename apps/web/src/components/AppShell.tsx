import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/RealtimeProvider';

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'font-semibold text-indigo-700' : 'text-slate-600 hover:text-slate-900';

/** Header, navigation, connection status and the "back to your room" banner (E-09). */
export function AppShell() {
  const { user, logout } = useAuth();
  const { connection, session } = useRealtime();
  const location = useLocation();
  const roomPath = session?.roomId ? `/rooms/${session.roomId}` : null;
  const showRoomBanner = roomPath !== null && location.pathname !== roomPath;

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <nav className="flex items-center gap-4 text-sm" aria-label="Main">
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
      {showRoomBanner && (
        <p className="mb-4 rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          Your session lives in {session?.roomName}.{' '}
          <NavLink to={roomPath} className="font-semibold underline">
            Back to the room
          </NavLink>
        </p>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
