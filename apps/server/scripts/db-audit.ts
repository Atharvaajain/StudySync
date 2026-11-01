/**
 * Runs the DATABASE_DESIGN §8 invariant audits against DATABASE_URL (read-only).
 * Exit code 1 if any violation is found. Intended for a nightly job in production.
 *   DATABASE_URL=... npm run db:audit -w @studysync/server
 */
import { existsSync } from 'node:fs';
import { runAudit } from '../src/lib/audit';
import { createPrisma } from '../src/lib/db';

const envFile = new URL('../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createPrisma(url);
try {
  const violations = await runAudit(db);
  if (violations.length === 0) {
    console.log('Invariant audit: OK (no violations).');
  } else {
    console.error(`Invariant audit: ${violations.length} violation(s)`);
    for (const v of violations) console.error(`  ${v}`);
    process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
