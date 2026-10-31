/**
 * Wire DTOs (API_DESIGN §2). Instants are ISO-8601 UTC strings with `Z`; durations are ms.
 * Phase 0 implements the subset needed by the prototype; fields that belong to later phases
 * are present with their documented "empty" value (e.g. `task: null`).
 */
import type { BreakMinutes } from './constants';

export type Instant = string;
export type Phase = 'STUDYING' | 'ON_BREAK' | 'BREAK_OVER';
export type RoomStatus = 'STUDYING' | 'ON_BREAK' | 'IDLE' | 'OFFLINE';
export type EndReason = 'USER' | 'DISCONNECTED' | 'IDLE_TIMEOUT';

export interface UserRef {
  id: string;
  name: string;
}

/** The caller's own active session. Never describes anyone else's timer (R1/R2). */
export interface SessionDto {
  id: string;
  phase: Phase;
  version: number;
  roomId: string | null;
  roomName: string | null;
  task: { id: string; title: string } | null;
  startedAt: Instant;
  studyMsClosed: number;
  currentSegmentStartedAt: Instant | null;
  break: { durationMinutes: BreakMinutes; startedAt: Instant; endsAt: Instant } | null;
  disconnectedAt: Instant | null;
  autoSaveAt: Instant | null;
}

export interface AutoSavedNotice {
  sessionId: string;
  endReason: 'DISCONNECTED' | 'IDLE_TIMEOUT';
  endedAt: Instant;
  studiedMs: number;
}

export type SessionCause =
  | 'CONNECT'
  | 'SYNC'
  | 'START'
  | 'BREAK'
  | 'BREAK_OVER'
  | 'RESUME'
  | 'END'
  | 'MOVED_TO_ROOM'
  | 'TASK_SET'
  | 'DISCONNECTED'
  | 'RECONNECTED'
  | 'AUTO_SAVED_DISCONNECT'
  | 'AUTO_SAVED_IDLE';

export interface SessionStatePayload {
  session: SessionDto | null;
  cause: SessionCause;
  lastAutoSaved: AutoSavedNotice | null;
  serverNow: Instant;
}

export interface RoomDto {
  id: string;
  name: string;
  code: string;
  createdBy: UserRef | null;
  isCreator: boolean;
  memberCount: number;
  createdAt: Instant;
}

export interface MemberStatusDto {
  user: UserRef;
  status: RoomStatus;
  breakEndsAt: Instant | null;
  reconnecting: boolean;
  version: number;
}

export interface SessionSummaryDto {
  id: string;
  startedAt: Instant;
  endedAt: Instant | null;
  endReason: EndReason | null;
  studiedMs: number;
  breaks: { count: number; totalMs: number };
  where: { roomId: string | null; roomName: string | null; movedFromSolo: boolean };
  task: { id: string; title: string } | null;
  completedTasks: { id: string; title: string }[];
}

export interface JoinRoomResult {
  room: RoomDto;
  members: MemberStatusDto[];
  /** Room tasks arrive in Phase 2; always empty in Phase 0. */
  tasks: never[];
  /** "Today in this room" arrives in Phase 2; always null in Phase 0. */
  today: null;
  session: SessionDto | null;
  serverNow: Instant;
}
