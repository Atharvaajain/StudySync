import { loadEnv } from './config/env';
import { createStudySyncServer } from './server';

const env = loadEnv();
const server = createStudySyncServer({ env });
const address = await server.listen(env.PORT, env.HOST);
server.logger.info(
  {
    url: `http://${address.address}:${address.port}`,
    nodeEnv: env.NODE_ENV,
    staticDir: env.STATIC_DIR,
  },
  'StudySync Phase 0 server listening',
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
