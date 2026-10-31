/**
 * Express app factory (no `listen`, so tests can mount it). Phase 0 exposes only health,
 * the optional static web build, and — in test mode only — the test clock (§17.6).
 */
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Env } from '../config/env';
import type { AdjustableClock, Clock } from '../lib/clock';
import type { Logger } from '../lib/logger';
import type { DeadlineScheduler } from '../lib/scheduler';
import { toIso } from '../lib/time';

export interface HttpAppDeps {
  env: Env;
  clock: Clock;
  scheduler: DeadlineScheduler;
  logger: Logger;
}

const testClockSchema = z.strictObject({
  advanceMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000),
});

function isAdjustable(clock: Clock): clock is AdjustableClock {
  return typeof (clock as Partial<AdjustableClock>).advance === 'function';
}

export function createHttpApp({ env, clock, scheduler, logger }: HttpAppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Phase 0 is never served over HTTPS (local / cloud container only).
      hsts: false,
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null, 'connect-src': ["'self'"] },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', phase: 0 });
  });

  if (env.ENABLE_TEST_CLOCK) {
    if (!isAdjustable(clock)) throw new Error('ENABLE_TEST_CLOCK requires an adjustable clock');
    // TEST ONLY: fast-forward the server clock and fire due deadlines (E2E breaks of 5–30 min).
    app.post('/__test__/clock', (req, res) => {
      const parsed = testClockSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: { code: 'VALIDATION_ERROR', message: 'advanceMs required' } });
        return;
      }
      clock.advance(parsed.data.advanceMs);
      scheduler.runDue();
      res.json({ now: toIso(clock.now()) });
    });
    logger.warn('Test clock endpoint enabled (POST /__test__/clock) — test mode only');
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  if (env.STATIC_DIR) {
    const dir = path.resolve(env.STATIC_DIR);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    // SPA fallback for client routes.
    app.use((req, res, next) => {
      if (
        req.method !== 'GET' ||
        req.path.startsWith('/socket.io') ||
        req.path.startsWith('/__test__')
      ) {
        next();
        return;
      }
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res
        .status(status)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'The request is not valid.' } });
      return;
    }
    logger.error({ err: error }, 'unhandled HTTP error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}
