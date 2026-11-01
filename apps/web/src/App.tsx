import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { ErrorBoundary, Loading } from './components/ui';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { JoinPage } from './pages/JoinPage';
import { RoomPage } from './pages/RoomPage';
import { SettingsPage } from './pages/SettingsPage';
import { SummaryPage } from './pages/SummaryPage';
import { safeNext } from './lib/safeNext';
import { RealtimeProvider } from './realtime/RealtimeProvider';

/** Anonymous visitor on a protected page (e.g. an invite link): log in, then come back. */
function ToLogin() {
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;
  return (
    <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  );
}

/** Signed in on /login or /register (or an unknown path): continue to `next`, else home. */
function AfterLogin() {
  const location = useLocation();
  const isAuthPage = location.pathname === '/login' || location.pathname === '/register';
  const next = isAuthPage ? safeNext(new URLSearchParams(location.search).get('next')) : '/';
  return <Navigate to={next} replace />;
}

/** Routes (ARCHITECTURE §16.1). Everything except login/register needs an account. */
function AppRoutes() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="flex justify-center p-8">
        <Loading label="Loading StudySync…" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<ToLogin />} />
      </Routes>
    );
  }
  return (
    <RealtimeProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="rooms/:roomId" element={<RoomPage />} />
          <Route path="join/:code" element={<JoinPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="sessions/:sessionId" element={<SummaryPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<AfterLogin />} />
      </Routes>
    </RealtimeProvider>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
