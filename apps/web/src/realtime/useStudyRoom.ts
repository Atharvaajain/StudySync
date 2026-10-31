/**
 * The client's realtime connection for the Phase 0 room.
 *
 * - The server is the source of truth: the client only sends commands (with a fresh
 *   commandId) and renders what the server pushes. It never sends instants or durations.
 * - Stale pushes are dropped by version (ARCHITECTURE §12.5).
 * - On every (re)connect the server sends `session_state`, and the client re-joins the room,
 *   so a refresh rebuilds the timer from server timestamps (F-32).
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  PROTOTYPE_ROOM,
  type AckResponse,
  type BreakMinutes,
  type ClientToServerEvents,
  type MemberStatusDto,
  type PrototypeIdentity,
  type RoomDto,
  type ServerToClientEvents,
  type SessionDto,
  type SessionSummaryDto,
} from '@studysync/shared';
import { serverClock } from '../lib/serverClock';
import { newUuid } from '../lib/uuid';

type StudySocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RoomState {
  connection: ConnectionState;
  connectionError: string | null;
  inRoom: boolean;
  room: RoomDto | null;
  members: Record<string, MemberStatusDto>;
  session: SessionDto | null;
  summary: SessionSummaryDto | null;
  error: string | null;
  pending: boolean;
}

type Action =
  | { type: 'connection'; connection: ConnectionState; error?: string | null }
  | { type: 'joined'; room: RoomDto; members: MemberStatusDto[]; session: SessionDto | null }
  | { type: 'left' }
  | { type: 'session'; session: SessionDto | null }
  | { type: 'member'; member: MemberStatusDto }
  | { type: 'member_offline'; userId: string }
  | { type: 'summary'; summary: SessionSummaryDto | null }
  | { type: 'error'; error: string | null }
  | { type: 'pending'; pending: boolean };

const initialState: RoomState = {
  connection: 'connecting',
  connectionError: null,
  inRoom: false,
  room: null,
  members: {},
  session: null,
  summary: null,
  error: null,
  pending: false,
};

/** Accept a session only if it is not older than what we hold (§12.5). */
function acceptSession(
  current: SessionDto | null,
  incoming: SessionDto | null,
  ended: Set<string>,
) {
  if (incoming === null) return null;
  if (ended.has(incoming.id)) return current; // a stale push about a session that already ended
  if (current && current.id === incoming.id && incoming.version < current.version) return current;
  return incoming;
}

function mergeMember(
  members: Record<string, MemberStatusDto>,
  member: MemberStatusDto,
): Record<string, MemberStatusDto> {
  const existing = members[member.user.id];
  if (existing && existing.version > member.version) return members;
  return { ...members, [member.user.id]: member };
}

function makeReducer(endedSessions: Set<string>) {
  return function reducer(state: RoomState, action: Action): RoomState {
    switch (action.type) {
      case 'connection':
        return { ...state, connection: action.connection, connectionError: action.error ?? null };
      case 'joined': {
        let members: Record<string, MemberStatusDto> = {};
        for (const m of action.members) members = mergeMember(members, m);
        // Keep any newer pushes that arrived before the snapshot.
        for (const m of Object.values(state.members)) members = mergeMember(members, m);
        return {
          ...state,
          inRoom: true,
          room: action.room,
          members,
          session: acceptSession(state.session, action.session, endedSessions),
        };
      }
      case 'left':
        return { ...state, inRoom: false };
      case 'session': {
        if (state.session && action.session === null) endedSessions.add(state.session.id);
        return { ...state, session: acceptSession(state.session, action.session, endedSessions) };
      }
      case 'member':
        return { ...state, members: mergeMember(state.members, action.member) };
      case 'member_offline': {
        const existing = state.members[action.userId];
        if (!existing) return state;
        return {
          ...state,
          members: {
            ...state.members,
            [action.userId]: {
              ...existing,
              status: 'OFFLINE',
              breakEndsAt: null,
              reconnecting: false,
            },
          },
        };
      }
      case 'summary':
        return { ...state, summary: action.summary };
      case 'error':
        return { ...state, error: action.error };
      case 'pending':
        return { ...state, pending: action.pending };
    }
  };
}

const ACK_TIMEOUT_MS = 8_000;
const CLOCK_RESYNC_MS = 30_000;

export function useStudyRoom(identity: PrototypeIdentity) {
  const endedSessions = useRef(new Set<string>()).current;
  const [state, dispatch] = useReducer(makeReducer(endedSessions), initialState);
  const socketRef = useRef<StudySocket | null>(null);
  const wantInRoom = useRef(true);

  const joinRoom = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    wantInRoom.current = true;
    const sentAt = Date.now();
    const res = await socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck('join_room', { roomId: PROTOTYPE_ROOM.id });
    if (res.ok) {
      serverClock.sampleRoundTrip(sentAt, res.data.serverNow, Date.now());
      dispatch({
        type: 'joined',
        room: res.data.room,
        members: res.data.members,
        session: res.data.session,
      });
      dispatch({ type: 'error', error: null });
    } else {
      dispatch({ type: 'error', error: res.error.message });
    }
  }, []);

  useEffect(() => {
    const socket: StudySocket = io({
      path: '/socket.io',
      auth: { userId: identity.userId, name: identity.name },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      dispatch({ type: 'connection', connection: 'connected' });
      const sentAt = Date.now();
      void socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('sync_state', {})
        .then((res) => {
          if (res.ok) serverClock.sampleRoundTrip(sentAt, res.data.serverNow, Date.now());
        })
        .catch(() => undefined);
      if (wantInRoom.current) void joinRoom().catch(() => undefined);
    });
    socket.on('disconnect', () => dispatch({ type: 'connection', connection: 'reconnecting' }));
    socket.on('connect_error', (err) => {
      dispatch({
        type: 'connection',
        connection: socket.active ? 'reconnecting' : 'failed',
        error: err.message,
      });
    });
    socket.on('session_state', (payload) => {
      serverClock.samplePush(payload.serverNow);
      dispatch({ type: 'session', session: payload.session });
    });
    socket.on('member_joined', ({ member }) => dispatch({ type: 'member', member }));
    socket.on('status_changed', ({ member }) => dispatch({ type: 'member', member }));
    socket.on('member_left', ({ userId }) => dispatch({ type: 'member_offline', userId }));

    // Keep sampling the server clock (median of samples, §16.2) so displays stay correct even
    // when this user's own session does not change for a long time.
    const resync = window.setInterval(() => {
      if (!socket.connected) return;
      const sentAt = Date.now();
      void socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('sync_state', {})
        .then((res) => {
          if (res.ok) serverClock.sampleRoundTrip(sentAt, res.data.serverNow, Date.now());
        })
        .catch(() => undefined);
    }, CLOCK_RESYNC_MS);

    return () => {
      window.clearInterval(resync);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [identity.userId, identity.name, joinRoom]);

  /** Send one timer command; the server decides. Rejections carry the current session. */
  const run = useCallback(
    async <T>(send: (socket: StudySocket) => Promise<AckResponse<T>>): Promise<T | null> => {
      const socket = socketRef.current;
      if (!socket) return null;
      dispatch({ type: 'pending', pending: true });
      try {
        const res = await send(socket);
        if (res.ok) {
          dispatch({ type: 'error', error: null });
          return res.data;
        }
        dispatch({ type: 'error', error: res.error.message });
        if (res.error.details && 'session' in res.error.details) {
          dispatch({ type: 'session', session: res.error.details.session as SessionDto | null });
        }
        return null;
      } catch {
        dispatch({ type: 'error', error: 'The server did not answer in time. Please try again.' });
        return null;
      } finally {
        dispatch({ type: 'pending', pending: false });
      }
    },
    [],
  );

  const sessionId = state.session?.id ?? null;
  const actions = {
    startStudy: async () => {
      dispatch({ type: 'summary', summary: null });
      const data = await run<{ session: SessionDto }>((s) =>
        s
          .timeout(ACK_TIMEOUT_MS)
          .emitWithAck('start_study', { commandId: newUuid(), roomId: PROTOTYPE_ROOM.id }),
      );
      if (data) dispatch({ type: 'session', session: data.session });
    },
    takeBreak: async (durationMinutes: BreakMinutes) => {
      if (!sessionId) return;
      const data = await run<{ session: SessionDto }>((s) =>
        s
          .timeout(ACK_TIMEOUT_MS)
          .emitWithAck('take_break', { commandId: newUuid(), sessionId, durationMinutes }),
      );
      if (data) dispatch({ type: 'session', session: data.session });
    },
    resumeStudy: async () => {
      if (!sessionId) return;
      const data = await run<{ session: SessionDto }>((s) =>
        s.timeout(ACK_TIMEOUT_MS).emitWithAck('resume_study', { commandId: newUuid(), sessionId }),
      );
      if (data) dispatch({ type: 'session', session: data.session });
    },
    endStudy: async () => {
      if (!sessionId) return;
      const data = await run<{ summary: SessionSummaryDto }>((s) =>
        s.timeout(ACK_TIMEOUT_MS).emitWithAck('end_study', { commandId: newUuid(), sessionId }),
      );
      if (data) {
        dispatch({ type: 'summary', summary: data.summary });
        dispatch({ type: 'session', session: null });
      }
    },
    leaveRoom: async () => {
      const socket = socketRef.current;
      if (!socket) return;
      wantInRoom.current = false;
      const res = await socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('leave_room', { roomId: PROTOTYPE_ROOM.id });
      if (res.ok) dispatch({ type: 'left' });
    },
    rejoinRoom: joinRoom,
    dismissSummary: () => dispatch({ type: 'summary', summary: null }),
    dismissError: () => dispatch({ type: 'error', error: null }),
  };

  return { state, actions };
}
