import { ERROR_MESSAGES, type AckError, type ErrorCode } from '@studysync/shared';

/** An expected, client-facing failure with a stable code (ARCHITECTURE §10). */
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

/** Raised by the store when a write would violate a data-integrity rule (DATABASE_DESIGN §5). */
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
