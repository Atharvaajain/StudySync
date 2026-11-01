import { existsSync } from 'node:fs';
import { loadEnv } from './config/env';
import { createStudySyncServer } from './server';

// Local development only: apps/server/.env (gitignored; see .env.example). Real env vars win.
// In production every setting comes from the host's environment, never from a stray file.
const envFile = new URL('../.env', import.meta.url);
if (process.env.NODE_ENV === 'production' && existsSync(envFile)) {
  // Prisma Client also auto-loads this file at import time, so it could silently override the
  // host's settings. Production configuration must come only from the environment.
  throw new Error('Refusing to start in production with apps/server/.env present: delete it.');
}
if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) process.loadEnvFile(envFile);

const env = loadEnv();
const server = createStudySyncServer({ env });
const address = await server.listen(env.PORT, env.HOST);
server.logger.info(
  {
    url: `http://${address.address}:${address.port}`,
    nodeEnv: env.NODE_ENV,
    staticDir: env.STATIC_DIR,
  },
  'StudySync server listening',
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.logger.info({ signal }, 'shutting down');
    void server.close().then(() => process.exit(0));
  });
}
