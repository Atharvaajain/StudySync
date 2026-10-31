import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;

/**
 * E2E: the built web app is served by the real server in test mode (same origin, like
 * production), with the test clock enabled so 5–30 minute breaks can be fast-forwarded.
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
    command: 'npm run start:e2e -w @studysync/server',
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
      STATIC_DIR: fileURLToPath(new URL('../apps/web/dist', import.meta.url)),
    },
  },
});
