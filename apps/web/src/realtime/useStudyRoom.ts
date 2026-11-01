/**
 * Presence in the Phase 0 prototype room on the app's shared socket.
 *
 * - Joins on mount and after every reconnect (presence is per socket).
 * - Leaving the room SCREEN ends this socket's presence only (ARCHITECTURE §11.3: the room stays
 *   live while it is open on another tab or device): the shared socket reconnects without a
 *   room. The explicit "Leave" button sends `leave_room` (all of my sockets). Membership is
 *   permanent either way (D-2).
 * - Member statuses are each member's OWN timer status. There is no room timer (R1/R2).
 * - Stale member pushes are dropped by version (§12.5).
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MemberStatusDto, RoomDto } from '@studysync/shared';
import { serverClock } from '../lib/serverClock';
import { useRealtime } from './RealtimeProvider';

export interface RoomState {
  inRoom: boolean;
  room: RoomDto | null;
  members: Record<string, MemberStatusDto>;
  error: string | null;
}

type Action =
  | { type: 'joined'; room: RoomDto; members: MemberStatusDto[] }
  | { type: 'left' }
  | { type: 'member'; member: MemberStatusDto }
  | { type: 'member_offline'; userId: string }
  | { type: 'error'; error: string | null };

const initialState: RoomState = { inRoom: false, room: null, members: {}, error: null };

function mergeMember(
  members: Record<string, MemberStatusDto>,
  member: MemberStatusDto,
): Record<string, MemberStatusDto> {
  const existing = members[member.user.id];
  if (existing && existing.version > member.version) return members;
  return { ...members, [member.user.id]: member };
}

function reducer(state: RoomState, action: Action): RoomState {
  switch (action.type) {
    case 'joined': {
      let members: Record<string, MemberStatusDto> = {};
      for (const m of action.members) members = mergeMember(members, m);
      // Keep any newer pushes that arrived before the snapshot.
      for (const m of Object.values(state.members)) members = mergeMember(members, m);
      return { ...state, inRoom: true, room: action.room, members, error: null };
    }
    case 'left':
      return { ...state, inRoom: false };
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
    case 'error':
      return { ...state, error: action.error };
  }
}

export function useStudyRoom(roomId: string) {
  const { socket, call, applySession } = useRealtime();
  const [state, dispatch] = useReducer(reducer, initialState);
  const wantInRoom = useRef(true);

  const join = useCallback(async () => {
    wantInRoom.current = true;
    const sentAt = Date.now();
    const res = await call('join_room', { roomId });
    if (res.ok) {
      serverClock.sampleRoundTrip(sentAt, res.data.serverNow, Date.now());
      dispatch({ type: 'joined', room: res.data.room, members: res.data.members });
      applySession(res.data.session);
    } else {
      dispatch({ type: 'error', error: res.error.message });
    }
  }, [call, roomId, applySession]);

  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      if (wantInRoom.current) void join();
    };
    const onMember = ({ roomId: r, member }: { roomId: string; member: MemberStatusDto }) => {
      if (r === roomId) dispatch({ type: 'member', member });
    };
    const onLeft = ({ roomId: r, userId }: { roomId: string; userId: string }) => {
      if (r === roomId) dispatch({ type: 'member_offline', userId });
    };
    socket.on('connect', onConnect);
    socket.on('member_joined', onMember);
    socket.on('status_changed', onMember);
    socket.on('member_left', onLeft);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('member_joined', onMember);
      socket.off('status_changed', onMember);
      socket.off('member_left', onLeft);
      // Leaving the screen: this socket stops showing the room (reconnect without a room).
      if (socket.connected && wantInRoom.current) {
        socket.disconnect();
        socket.connect();
      }
    };
  }, [socket, roomId, join]);

  const leave = useCallback(async () => {
    wantInRoom.current = false;
    const res = await call('leave_room', { roomId });
    if (res.ok) dispatch({ type: 'left' });
  }, [call, roomId]);

  return {
    state,
    join,
    leave,
    dismissError: () => dispatch({ type: 'error', error: null }),
  };
}
