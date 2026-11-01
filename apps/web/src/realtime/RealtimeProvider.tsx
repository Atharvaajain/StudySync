/**
 * One Socket.IO connection for the signed-in app (ARCHITECTURE §12, §16.2).
 *
 * - Authenticated with the in-memory access token (`auth.token`); renewed with `auth_renew`
 *   whenever the token is refreshed. TOKEN_EXPIRED / `auth_expired` → refresh, then reconnect.
 * - The server is the source of truth: on every (re)connect it sends `session_state`, so a
 *   refresh rebuilds the timer from server timestamps (F-32). Stale pushes are dropped by
 *   version (§12.5).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  AckResponse,
  AutoSavedNotice,
  ClientToServerEvents,
  ServerToClientEvents,
  SessionCause,
  SessionDto,
} from '@studysync/shared';
import { accessToken, api, onAuthChange, refreshSession } from '../lib/api';
import { serverClock } from '../lib/serverClock';
import { acceptSession } from './sessionGuard';

export type StudySocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

type AckData<E extends keyof ClientToServerEvents> =
  Parameters<Parameters<ClientToServerEvents[E]>[1]>[0] extends AckResponse<infer T> ? T : never;

export interface RealtimeValue {
  connection: ConnectionState;
  connectionError: string | null;
  session: SessionDto | null;
  /** Cause of the last accepted session change (drives refetches of totals). */
  lastCause: SessionCause | null;
  /** Increments on every accepted session change. */
  revision: number;
  socket: StudySocket | null;
  call<E extends keyof ClientToServerEvents>(
    event: E,
    payload: Parameters<ClientToServerEvents[E]>[0],
  ): Promise<AckResponse<AckData<E>>>;
  /** Apply a session from an ack or a rejection's `details.session` (version-guarded). */
  applySession(session: SessionDto | null, cause?: SessionCause): void;
  /** An unseen session the server saved on its own (disconnect / idle), F-40. */
  lastAutoSaved: AutoSavedNotice | null;
  dismissAutoSaved(): void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const ACK_TIMEOUT_MS = 8_000;
const CLOCK_RESYNC_MS = 30_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<StudySocket | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<{
    session: SessionDto | null;
    cause: SessionCause | null;
    revision: number;
  }>({ session: null, cause: null, revision: 0 });
  const ended = useRef(new Set<string>());
  const [lastAutoSaved, setLastAutoSaved] = useState<AutoSavedNotice | null>(null);

  const applySession = useCallback((incoming: SessionDto | null, cause?: SessionCause) => {
    setSessionState((current) => {
      const next = acceptSession(current.session, incoming, ended.current);
      if (next === current.session && cause === undefined) return current;
      return { session: next, cause: cause ?? current.cause, revision: current.revision + 1 };
    });
  }, []);

  useEffect(() => {
    const s: StudySocket = io({
      path: '/socket.io',
      // Called on every (re)connection attempt: always the latest in-memory token.
      auth: (cb) => cb({ token: accessToken() ?? '' }),
      transports: ['websocket', 'polling'],
    });
    setSocket(s);

    const sampleClock = () => {
      const sentAt = Date.now();
      void s
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('sync_state', {})
        .then((res) => {
          if (res.ok) serverClock.sampleRoundTrip(sentAt, res.data.serverNow, Date.now());
        })
        .catch(() => undefined);
    };

    const refreshAndReconnect = async () => {
      setConnection('reconnecting');
      const auth = await refreshSession();
      if (auth) s.connect(); // otherwise the user is logged out and this provider unmounts
    };

    s.on('connect', () => {
      setConnection('connected');
      setConnectionError(null);
      sampleClock();
    });
    s.on('disconnect', (reason) => {
      setConnection('reconnecting');
      // The server closed the socket (token expiry): refresh and reconnect ourselves.
      if (reason === 'io server disconnect') void refreshAndReconnect();
    });
    s.on('connect_error', (err) => {
      setConnectionError(err.message);
      if (err.message === 'TOKEN_EXPIRED' || err.message === 'UNAUTHENTICATED') {
        void refreshAndReconnect();
        return;
      }
      setConnection(s.active ? 'reconnecting' : 'failed');
    });
    s.on('auth_expired', () => {
      // The server disconnects next; 'disconnect' handles the reconnect.
    });
    s.on('session_state', (payload) => {
      serverClock.samplePush(payload.serverNow);
      applySession(payload.session, payload.cause);
      setLastAutoSaved(payload.lastAutoSaved);
    });

    const unsubscribe = onAuthChange((auth) => {
      if (auth && s.connected) {
        void s
          .timeout(ACK_TIMEOUT_MS)
          .emitWithAck('auth_renew', { token: auth.accessToken })
          .catch(() => undefined);
      }
    });
    const resync = window.setInterval(() => {
      if (s.connected) sampleClock();
    }, CLOCK_RESYNC_MS);

    return () => {
      window.clearInterval(resync);
      unsubscribe();
      s.removeAllListeners();
      s.disconnect();
      setSocket(null);
    };
  }, [applySession]);

  const call = useCallback(
    async <E extends keyof ClientToServerEvents>(
      event: E,
      payload: Parameters<ClientToServerEvents[E]>[0],
    ): Promise<AckResponse<AckData<E>>> => {
      if (!socket) {
        return { ok: false, error: { code: 'INTERNAL', message: 'Not connected yet.' } };
      }
      const emit = socket.timeout(ACK_TIMEOUT_MS).emitWithAck as unknown as (
        e: E,
        p: unknown,
      ) => Promise<AckResponse<AckData<E>>>;
      try {
        return await emit.call(socket.timeout(ACK_TIMEOUT_MS), event, payload);
      } catch {
        return {
          ok: false,
          error: {
            code: 'INTERNAL',
            message: 'The server did not answer in time. Please try again.',
          },
        };
      }
    },
    [socket],
  );

  const dismissAutoSaved = useCallback(() => {
    setLastAutoSaved((notice) => {
      if (notice) {
        void api(`/sessions/${notice.sessionId}/summary-seen`, { method: 'POST' }).catch(
          () => undefined,
        );
      }
      return null;
    });
  }, []);

  const value = useMemo<RealtimeValue>(
    () => ({
      connection,
      connectionError,
      session: sessionState.session,
      lastCause: sessionState.cause,
      revision: sessionState.revision,
      socket,
      call,
      applySession,
      lastAutoSaved,
      dismissAutoSaved,
    }),
    [
      connection,
      connectionError,
      sessionState,
      socket,
      call,
      applySession,
      lastAutoSaved,
      dismissAutoSaved,
    ],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}
