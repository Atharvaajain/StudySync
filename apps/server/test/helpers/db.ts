/**
 * Test database helpers (TESTING_STRATEGY §4). Tests run against a real PostgreSQL 16
 * database (`studysync_test`), migrated once per run in `globalSetup`, truncated between tests.
 * After every DB-backed test the invariant audit queries (DATABASE_DESIGN §8, A–H) must
 * return no rows.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv, type Env } from '../../src/config/env';
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

type Row = { id: unknown }[];

const AUDITS: Record<string, (db: Db) => Promise<Row>> = {
  'A segment overlaps break': (db) => db.$queryRaw<Row>`
    SELECT g.id FROM study_segments g JOIN study_breaks b ON b.user_id = g.user_id
     AND tstzrange(g.started_at, g.ended_at, '[)') && tstzrange(b.started_at, b.closed_at, '[)')`,
  'B studying ⇔ one open segment': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    LEFT JOIN study_segments g ON g.session_id = ss.id AND g.ended_at IS NULL
    WHERE ss.status = 'ACTIVE'
      AND ((ss.current_segment_started_at IS NULL) <> (g.id IS NULL)
           OR g.started_at IS DISTINCT FROM ss.current_segment_started_at)`,
  'C on break ⇔ one open break': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    LEFT JOIN study_breaks b ON b.session_id = ss.id AND b.closed_at IS NULL
    WHERE ss.status = 'ACTIVE'
      AND ((ss.break_ends_at IS NULL) <> (b.id IS NULL) OR b.ends_at IS DISTINCT FROM ss.break_ends_at)`,
  'D ended sessions clean': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    WHERE ss.status = 'ENDED' AND (
          EXISTS (SELECT 1 FROM study_segments g WHERE g.session_id = ss.id AND (g.ended_at IS NULL OR g.ended_at > ss.ended_at OR g.started_at < ss.started_at))
       OR EXISTS (SELECT 1 FROM study_breaks  b WHERE b.session_id = ss.id AND (b.closed_at IS NULL OR b.closed_at > ss.ended_at OR b.started_at < ss.started_at)))`,
  'E only users enter STUDYING': (db) => db.$queryRaw<Row>`
    SELECT id FROM session_events
    WHERE to_phase = 'STUDYING' AND from_phase <> 'STUDYING' AND actor <> 'USER'`,
  'F resume continues at the same instant': (db) => db.$queryRaw<Row>`
    SELECT b.id FROM study_breaks b
    WHERE b.close_reason = 'RESUMED'
      AND NOT EXISTS (SELECT 1 FROM study_segments g WHERE g.session_id = b.session_id AND g.started_at = b.closed_at)`,
  'G room session user is a member': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    WHERE ss.room_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ss.room_id AND m.user_id = ss.user_id)`,
  'H rooms have no timer columns': (db) => db.$queryRaw<Row>`
    SELECT column_name AS id FROM information_schema.columns
    WHERE table_name = 'rooms' AND column_name ~ '(timer|break|segment|started|ends_at|duration)'`,
};

/** DATABASE_DESIGN §8: any returned row is a bug. Returns human-readable violations. */
export async function audit(db: Db = testDb()): Promise<string[]> {
  const violations: string[] = [];
  for (const [name, query] of Object.entries(AUDITS)) {
    for (const row of await query(db)) violations.push(`${name}: ${String(row.id)}`);
  }
  return violations;
}
