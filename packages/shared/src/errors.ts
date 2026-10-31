/** Error codes used in socket acks (API_DESIGN §3). Phase 0 subset. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'TOO_MANY_CONNECTIONS',
  'NOT_FOUND',
  'ROOM_FULL',
  'RATE_LIMITED',
  'SESSION_ALREADY_ACTIVE',
  'NO_ACTIVE_SESSION',
  'STALE_SESSION',
  'NOT_STUDYING',
  'BREAK_NOT_OVER',
  'NOT_ON_BREAK',
  'MUST_START_IN_CURRENT_ROOM',
  'NOT_IN_SESSION_ROOM',
  'SESSION_IN_OTHER_ROOM',
  'TASK_NOT_ATTACHABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes the pure timer machine can return (ARCHITECTURE §13.4 rows 13–21). */
export type TimerRejectionCode = Extract<
  ErrorCode,
  | 'VALIDATION_ERROR'
  | 'SESSION_ALREADY_ACTIVE'
  | 'NO_ACTIVE_SESSION'
  | 'STALE_SESSION'
  | 'NOT_STUDYING'
  | 'BREAK_NOT_OVER'
  | 'NOT_ON_BREAK'
  | 'MUST_START_IN_CURRENT_ROOM'
  | 'NOT_IN_SESSION_ROOM'
  | 'SESSION_IN_OTHER_ROOM'
>;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'The request is not valid.',
  UNAUTHENTICATED: 'Identify yourself before connecting.',
  TOO_MANY_CONNECTIONS: 'Too many open connections for this user.',
  NOT_FOUND: 'Not found.',
  ROOM_FULL: 'This room is full.',
  RATE_LIMITED: 'Too many requests. Slow down a little.',
  SESSION_ALREADY_ACTIVE: 'You already have an active study session.',
  NO_ACTIVE_SESSION: 'You have no active study session.',
  STALE_SESSION: 'That session is no longer your active session.',
  NOT_STUDYING: 'You can only take a break while studying.',
  BREAK_NOT_OVER: 'Your break is not over yet.',
  NOT_ON_BREAK: 'You are not on a break.',
  MUST_START_IN_CURRENT_ROOM: 'Start studying from the room you are in.',
  NOT_IN_SESSION_ROOM: 'Go back to the room to resume.',
  SESSION_IN_OTHER_ROOM: 'End your study session in the other room first.',
  TASK_NOT_ATTACHABLE: 'That task cannot be attached to this session.',
  INTERNAL: 'Something went wrong.',
};
