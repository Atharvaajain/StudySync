/**
 * Vitest global setup for DB-backed projects: bring the dedicated test database up to the
 * committed migrations (`prisma migrate deploy`, exactly like a deployment). Tests then clear
 * its tables between cases (helpers/db.ts). A guard refuses any database not named `*_test`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL, assertTestDatabase } from './helpers/testDatabaseUrl';

export default function setup(): void {
  assertTestDatabase(TEST_DATABASE_URL);
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
  } catch (error) {
    const output = (error as { stdout?: Buffer; stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(
      `prisma migrate deploy failed for the test database. Is PostgreSQL running ` +
        `(scripts/dev-db.sh)?\n${output}`,
      { cause: error },
    );
  }
}
