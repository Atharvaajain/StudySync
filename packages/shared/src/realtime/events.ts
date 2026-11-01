/**
 * Typed Socket.IO contract (API_DESIGN §7–§8). Event names are the spec's names, verbatim.
 * Phase 1: room presence (Phase 0 room), the timer commands, task attach, personal tasks,
 * resync and token renewal.
 */
import type { ErrorCode } from '../errors';
import type {
  JoinRoomResult,
  MemberStatusDto,
  SessionDto,
  SessionStatePayload,
  SessionSummaryDto,
  TaskDto,
} from '../dto';
import type {
  AuthRenewPayload,
  EndStudyPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  ResumeStudyPayload,
  SetSessionTaskPayload,
  StartStudyPayload,
  SyncStatePayload,
  TakeBreakPayload,
  TaskAddPayload,
  TaskDeletePayload,
  TaskTogglePayload,
  TaskUpdatePayload,
} from '../schemas';

export interface AckError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type AckResponse<T> = { ok: true; data: T } | { ok: false; error: AckError };
export type Ack<T> = (response: AckResponse<T>) => void;

export interface ClientToServerEvents {
  join_room: (payload: JoinRoomPayload, ack: Ack<JoinRoomResult>) => void;
  leave_room: (payload: LeaveRoomPayload, ack: Ack<Record<string, never>>) => void;
  start_study: (payload: StartStudyPayload, ack: Ack<{ session: SessionDto }>) => void;
  take_break: (payload: TakeBreakPayload, ack: Ack<{ session: SessionDto }>) => void;
  resume_study: (payload: ResumeStudyPayload, ack: Ack<{ session: SessionDto }>) => void;
  end_study: (payload: EndStudyPayload, ack: Ack<{ summary: SessionSummaryDto }>) => void;
  set_session_task: (payload: SetSessionTaskPayload, ack: Ack<{ session: SessionDto }>) => void;
  task_add: (payload: TaskAddPayload, ack: Ack<{ task: TaskDto }>) => void;
  task_toggle: (payload: TaskTogglePayload, ack: Ack<{ task: TaskDto }>) => void;
  task_update: (payload: TaskUpdatePayload, ack: Ack<{ task: TaskDto }>) => void;
  task_delete: (payload: TaskDeletePayload, ack: Ack<Record<string, never>>) => void;
  sync_state: (payload: SyncStatePayload, ack: Ack<SessionStatePayload>) => void;
  auth_renew: (payload: AuthRenewPayload, ack: Ack<{ expiresAt: string }>) => void;
}

export interface PersonalTaskUpdatedPayload {
  action: 'added' | 'updated' | 'deleted';
  task?: TaskDto;
  taskId: string;
}

export interface ServerToClientEvents {
  session_state: (payload: SessionStatePayload) => void;
  member_joined: (payload: { roomId: string; member: MemberStatusDto }) => void;
  member_left: (payload: { roomId: string; userId: string }) => void;
  status_changed: (payload: { roomId: string; member: MemberStatusDto }) => void;
  personal_task_updated: (payload: PersonalTaskUpdatedPayload) => void;
  auth_expired: (payload: Record<string, never>) => void;
}

/** Channel names (ARCHITECTURE §12.2). */
export const userChannel = (userId: string): string => `user:${userId}`;
export const roomChannel = (roomId: string): string => `room:${roomId}`;
