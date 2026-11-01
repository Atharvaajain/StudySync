/**
 * Test database helpers (TESTING_STRATEGY §4). Tests run against a real PostgreSQL 16
 * database (`studysync_test`), migrated once per run in `globalSetup`, truncated between tests.
 * After every DB-backed test the invariant audit queries (DATABASE_DESIGN §8, A–H) must
 * return no rows.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv, type Env } from '../../src/config/env';
import { runAudit } from '../../src/lib/audit';
import { createPrisma, type Db } from '../../src/lib/db';

import { TEST_DATABASE_URL, assertTestDatabase } from './testDatabaseUrl';

export { TEST_DATABASE_URL };

export const TEST_JWT_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';

/** One client per test file (vitest isolates files), shared by every server in that file. */
let shared: Db | null = null;
export function testDb(): Db {
  assertTestDatabase(TEST_DATABASE_URL);
  shared ??= createPrisma(TEST_DATABASE_URL);
  return shared;
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    BCRYPT_COST: '4',
    COOKIE_SECURE: 'true',
    ...overrides,
  });
}

export async function resetDb(db: Db = testDb()): Promise<void> {
  await db.$executeRaw`
    TRUNCATE session_events, study_breaks, study_segments, study_sessions, tasks, room_members,
             rooms, refresh_tokens, users RESTART IDENTITY CASCADE`;
}

/** Inserts a user directly (no bcrypt): fast fixtures for realtime and service tests. */
export async function createUser(
  db: Db,
  options: { name?: string; timezone?: string; id?: string; email?: string } = {},
): Promise<{ id: string; name: string; email: string; timezone: string }> {
  const id = options.id ?? randomUUID();
  return db.user.create({
    data: {
      id,
      name: options.name ?? 'Test User',
      email: options.email ?? `${id}@test.studysync.local`,
      passwordHash: 'not-a-real-hash',
      timezone: options.timezone ?? 'UTC',
    },
    select: { id: true, name: true, email: true, timezone: true },
  });
}

/** DATABASE_DESIGN §8: any returned row is a bug. Returns human-readable violations. */
export function audit(db: Db = testDb()): Promise<string[]> {
  return runAudit(db);
}
