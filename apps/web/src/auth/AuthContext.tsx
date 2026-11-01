/**
 * Authentication state for the whole app (ARCHITECTURE §16.1, step 1.3): silent refresh on
 * load, proactive refresh before the access token expires, logout.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserDto } from '@studysync/shared';
import { accessTokenExpiresAt, authApi, onAuthChange, refreshSession } from '../lib/api';
import { serverClock } from '../lib/serverClock';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: UserDto | null;
  login(email: string, password: string): Promise<void>;
  register(input: {
    name: string;
    email: string;
    password: string;
    timezone: string;
  }): Promise<void>;
  logout(): Promise<void>;
  setUser(user: UserDto): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUserState] = useState<UserDto | null>(null);

  useEffect(
    () =>
      onAuthChange((auth) => {
        setUserState(auth?.user ?? null);
        setStatus(auth ? 'authenticated' : 'anonymous');
      }),
    [],
  );

  // Silent refresh on load: a valid refresh cookie keeps the user logged in across reloads.
  useEffect(() => {
    void refreshSession().then((auth) => {
      if (!auth) setStatus('anonymous');
    });
  }, []);

  // Proactive refresh shortly before expiry (the socket renews with the new token).
  useEffect(() => {
    if (status !== 'authenticated') return;
    // Expiry is a server instant: compare it with the corrected server clock (§16.2).
    const delay = Math.max(5_000, accessTokenExpiresAt() - serverClock.now() - REFRESH_LEAD_MS);
    const id = window.setTimeout(() => void refreshSession(), delay);
    return () => window.clearTimeout(id);
  }, [status, user]);

  const login = useCallback(async (email: string, password: string) => {
    await authApi.login({ email, password });
  }, []);
  const register = useCallback(
    async (input: { name: string; email: string; password: string; timezone: string }) => {
      await authApi.register(input);
    },
    [],
  );
  const logout = useCallback(async () => {
    await authApi.logout();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout, setUser: setUserState }),
    [status, user, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
