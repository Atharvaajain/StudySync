/**
 * PostgreSQL access through Prisma (ARCHITECTURE §8, DATABASE_DESIGN).
 *
 * - Every session mutation runs in one transaction that first takes the per-user advisory lock
 *   (§13.8), so start / commands / room moves of one user are serialized across instances.
 * - Instants are always passed in from the injected Clock; SQL `now()` is never used in time logic.
 */
import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export { Prisma };

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/** Interactive transaction with generous limits (commands queue per user, never for long). */
export function transaction<T>(db: Db, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(run, { maxWait: 10_000, timeout: 15_000 });
}

/** `pg_advisory_xact_lock(user key)`: released automatically at COMMIT / ROLLBACK. */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
}

/** Unique-constraint violation (Prisma P2002), optionally on a specific target. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export const toDate = (epochMs: number): Date => new Date(epochMs);
export const toDateOrNull = (epochMs: number | null): Date | null =>
  epochMs === null ? null : new Date(epochMs);
export const msOf = (date: Date): number => date.getTime();
export const msOrNull = (date: Date | null): number | null =>
  date === null ? null : date.getTime();
