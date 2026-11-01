/**
 * Prepares the dedicated E2E database before the Playwright run: apply the committed
 * migrations (`prisma migrate deploy`) and clear every table. Refuses any database whose name
 * does not end with `_e2e`, so it can never touch development or real data.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const name = new URL(url).pathname.replace(/^\//, '');
if (!name.endsWith('_e2e')) {
  throw new Error(`Refusing to prepare "${name}" for E2E: the database name must end with _e2e.`);
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  stdio: 'inherit',
});

const db = new PrismaClient({ datasources: { db: { url } } });
await db.$executeRaw`
  TRUNCATE session_events, study_breaks, study_segments, study_sessions, tasks, room_members,
           rooms, refresh_tokens, users RESTART IDENTITY CASCADE`;
await db.$disconnect();
console.log(`E2E database ${name} is migrated and empty.`);
