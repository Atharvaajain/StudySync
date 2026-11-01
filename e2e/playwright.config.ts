import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://studysync:studysync@127.0.0.1:5432/studysync_e2e?schema=public';

/**
 * E2E: the built web app is served by the real server in test mode (same origin, like
 * production), on a dedicated PostgreSQL database (`studysync_e2e`, migrated and emptied before
 * the run), with the test clock enabled so 5–30 minute breaks can be fast-forwarded.
 * Browsers: the Chromium build pre-installed in the cloud container (never `playwright install`).
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './.artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: './.artifacts/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npm run e2e:prepare-db -w @studysync/server && npm run start:e2e -w @studysync/server',
    cwd: root,
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ENABLE_TEST_CLOCK: 'true',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      DATABASE_URL: E2E_DATABASE_URL,
      JWT_ACCESS_SECRET: 'e2e-only-secret-not-for-real-use-0123456789abcdef',
      // Plain http://127.0.0.1 in the test run: the refresh cookie can't be `Secure` here.
      COOKIE_SECURE: 'false',
      // Many registrations from one IP in one run.
      RELAX_RATE_LIMITS: 'true',
      BCRYPT_COST: '4',
      STATIC_DIR: fileURLToPath(new URL('../apps/web/dist', import.meta.url)),
    },
  },
});
