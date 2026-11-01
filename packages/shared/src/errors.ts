/** Error codes used in REST responses and socket acks (API_DESIGN §3). */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_TIMEZONE',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'INVALID_CREDENTIALS',
  'REFRESH_INVALID',
  'REFRESH_REUSED',
  'CSRF_REQUIRED',
  'FORBIDDEN',
  'TOO_MANY_CONNECTIONS',
  'NOT_FOUND',
  'EMAIL_TAKEN',
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
  'VERSION_CONFLICT',
  'ID_CONFLICT',
  'TASK_LIMIT_REACHED',
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
  INVALID_TIMEZONE: 'That is not a valid timezone.',
  UNAUTHENTICATED: 'Please log in.',
  TOKEN_EXPIRED: 'Your login has expired. Please refresh.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  REFRESH_INVALID: 'Your login has expired. Please log in again.',
  REFRESH_REUSED: 'For your security you have been logged out. Please log in again.',
  CSRF_REQUIRED: 'Missing security header.',
  FORBIDDEN: 'You are not allowed to do that.',
  TOO_MANY_CONNECTIONS: 'Too many open connections for this user.',
  NOT_FOUND: 'Not found.',
  EMAIL_TAKEN: 'An account with this email already exists.',
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
  VERSION_CONFLICT: 'This task was changed elsewhere. Showing the latest version.',
  ID_CONFLICT: 'A different task with this id already exists.',
  TASK_LIMIT_REACHED: 'You have reached the task limit.',
  INTERNAL: 'Something went wrong.',
};
