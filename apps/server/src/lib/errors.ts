import { ERROR_MESSAGES, type AckError, type ErrorCode } from '@studysync/shared';

/** An expected, client-facing failure with a stable code (ARCHITECTURE §10, API_DESIGN §3). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: Record<string, unknown>,
    message: string = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'AppError';
  }

  toAckError(): AckError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

/** Raised when a write would violate a data-integrity rule (DATABASE_DESIGN §5). */
export class IntegrityError extends Error {
  constructor(
    readonly constraint: string,
    message: string,
  ) {
    super(`${constraint}: ${message}`);
    this.name = 'IntegrityError';
  }
}

export function toAckError(error: unknown): AckError {
  if (error instanceof AppError) return error.toAckError();
  return { code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL };
}

/** HTTP status for each error code (API_DESIGN §3). */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_TIMEZONE: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  REFRESH_INVALID: 401,
  REFRESH_REUSED: 401,
  CSRF_REQUIRED: 403,
  FORBIDDEN: 403,
  TOO_MANY_CONNECTIONS: 429,
  NOT_FOUND: 404,
  INVALID_CODE: 404,
  EMAIL_TAKEN: 409,
  ROOM_FULL: 409,
  RATE_LIMITED: 429,
  SESSION_ALREADY_ACTIVE: 409,
  NO_ACTIVE_SESSION: 409,
  STALE_SESSION: 409,
  NOT_STUDYING: 409,
  BREAK_NOT_OVER: 409,
  NOT_ON_BREAK: 409,
  MUST_START_IN_CURRENT_ROOM: 409,
  NOT_IN_SESSION_ROOM: 409,
  SESSION_IN_OTHER_ROOM: 409,
  TASK_NOT_ATTACHABLE: 409,
  VERSION_CONFLICT: 409,
  ID_CONFLICT: 409,
  TASK_LIMIT_REACHED: 409,
  INTERNAL: 500,
};
