import { existsSync } from 'node:fs';
import { loadEnv } from './config/env';
import { createStudySyncServer } from './server';

// Local development: apps/server/.env (gitignored; see .env.example). Real env vars win.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

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
