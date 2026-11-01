import type { z } from 'zod';
import { AppError } from './errors';

/** Zod boundary validation shared by REST and sockets (§17.3). Never echoes the input back. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((i) => i.message === 'INVALID_TIMEZONE')) {
    throw new AppError('INVALID_TIMEZONE');
  }
  throw new AppError('VALIDATION_ERROR', {
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}
