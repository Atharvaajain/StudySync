/**
 * REST client (API_DESIGN §1). The access token lives in memory only (never in localStorage,
 * §17.1). On a 401 the client refreshes once (single-flight, cross-tab via Web Locks) and
 * retries. The refresh token is an httpOnly cookie the page can't read.
 */
import { CSRF_HEADER, type AuthResponse, type ErrorCode } from '@studysync/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface TokenState {
  token: string | null;
  expiresAt: number;
}

const tokenState: TokenState = { token: null, expiresAt: 0 };
const listeners = new Set<(auth: AuthResponse | null) => void>();

export function accessToken(): string | null {
  return tokenState.token;
}

export function accessTokenExpiresAt(): number {
  return tokenState.expiresAt;
}

/** Subscribe to token changes (the socket renews its token; logout everywhere). */
export function onAuthChange(listener: (auth: AuthResponse | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAuth(auth: AuthResponse | null): void {
  tokenState.token = auth?.accessToken ?? null;
  tokenState.expiresAt = auth ? Date.parse(auth.accessTokenExpiresAt) : 0;
  for (const l of listeners) l(auth);
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
    };
    if (body.error) {
      return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
    }
  } catch {
    // not JSON
  }
  return new ApiError(res.status, 'INTERNAL', 'Something went wrong.');
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach StudySync. Check your connection.');
  }
}

let refreshing: Promise<AuthResponse | null> | null = null;

/**
 * Exchange the refresh cookie for a new access token. Single-flight in this tab, and
 * serialized across tabs with the Web Locks API so two tabs never present the same
 * (rotated) refresh token — which would be treated as reuse and log the user out.
 */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    const run = async (): Promise<AuthResponse | null> => {
      const res = await rawFetch('/auth/refresh', {
        method: 'POST',
        headers: { [CSRF_HEADER]: '1' },
      });
      if (!res.ok) {
        setAuth(null);
        return null;
      }
      const auth = (await res.json()) as AuthResponse;
      setAuth(auth);
      return auth;
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request('studysync-auth-refresh', run);
      }
      return await run();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; retry?: boolean } = {},
): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (tokenState.token) headers.Authorization = `Bearer ${tokenState.token}`;
    return rawFetch(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  };
  let res = await send();
  if (res.status === 401 && options.retry !== false && tokenState.token) {
    const refreshed = await refreshSession();
    if (refreshed) res = await send();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Auth endpoints (cookie-based ones need the CSRF header). */
export const authApi = {
  async register(body: {
    name: string;
    email: string;
    password: string;
    timezone: string;
  }): Promise<AuthResponse> {
    const res = await rawFetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    const auth = (await res.json()) as AuthResponse;
    setAuth(auth);
    return auth;
  },
  async login(body: { email: string; password: string }): Promise<AuthResponse> {
    const res = await rawFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    const auth = (await res.json()) as AuthResponse;
    setAuth(auth);
    return auth;
  },
  async logout(): Promise<void> {
    await rawFetch('/auth/logout', { method: 'POST', headers: { [CSRF_HEADER]: '1' } });
    setAuth(null);
  },
};

/** Human-readable message for any error thrown by the API layer. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong.';
}
