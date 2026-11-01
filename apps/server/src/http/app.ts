/**
 * Express app factory (no `listen`, so tests can mount it). REST covers auth, profile, reads
 * and stats (API_DESIGN §4); every session and task mutation is a socket event.
 */
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { ERROR_MESSAGES } from '@studysync/shared';
import type { Env } from '../config/env';
import type { AdjustableClock, Clock } from '../lib/clock';
import type { Db } from '../lib/db';
import { AppError, HTTP_STATUS } from '../lib/errors';
import type { KeyedQueue } from '../lib/keyedQueue';
import type { Logger } from '../lib/logger';
import type { DeadlineScheduler } from '../lib/scheduler';
import { toIso } from '../lib/time';
import { authRoutes } from '../modules/auth/auth.routes';
import type { AuthService } from '../modules/auth/authService';
import type { TokenService } from '../modules/auth/tokens';
import { sessionsRoutes } from '../modules/sessions/sessions.routes';
import type { SessionService } from '../modules/sessions/sessionService';
import { statsRoutes } from '../modules/stats/stats.routes';
import type { StatsService } from '../modules/stats/statsService';
import { tasksRoutes } from '../modules/tasks/tasks.routes';
import type { TaskService } from '../modules/tasks/taskService';
import { usersRoutes } from '../modules/users/users.routes';
import type { UserService } from '../modules/users/userService';
import { byUser, limiter, requestId, requireAuth, type HttpRateLimits } from './middleware';

export interface HttpAppDeps {
  env: Env;
  clock: Clock;
  scheduler: DeadlineScheduler;
  logger: Logger;
  db: Db;
  queue: KeyedQueue;
  tokens: TokenService;
  auth: AuthService;
  users: UserService;
  tasks: TaskService;
  sessions: SessionService;
  stats: StatsService;
  rateLimits: HttpRateLimits;
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

export function createHttpApp(deps: HttpAppDeps): express.Express {
  const { env, clock, scheduler, logger, db } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Development builds are never served over HTTPS (local / cloud container only).
      hsts: false,
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null, 'connect-src': ["'self'"] },
      },
    }),
  );
  app.use(requestId);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', phase: 1 });
  });
  app.get('/api/v1/health/ready', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
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

  const authed = [
    requireAuth(deps.tokens),
    limiter({ windowMs: 60_000, limit: deps.rateLimits.readsPerUser, key: byUser }),
  ];
  app.use('/api/v1/auth', authRoutes({ env, auth: deps.auth, limits: deps.rateLimits }));
  app.use('/api/v1/users', ...authed, usersRoutes(deps.users));
  app.use('/api/v1/tasks', ...authed, tasksRoutes(deps.tasks));
  app.use(
    '/api/v1/sessions',
    ...authed,
    sessionsRoutes({ sessions: deps.sessions, queue: deps.queue, clock }),
  );
  app.use('/api/v1/stats', ...authed, statsRoutes(deps.stats));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: ERROR_MESSAGES.NOT_FOUND } });
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
    const requestIdValue = res.locals.requestId as string | undefined;
    if (error instanceof AppError) {
      const body: Record<string, unknown> = {
        code: error.code,
        message: error.message,
        requestId: requestIdValue,
      };
      if (error.details) body.details = error.details;
      res.status(HTTP_STATUS[error.code]).json({ error: body });
      return;
    }
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status === 413 ? 413 : 400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: ERROR_MESSAGES.VALIDATION_ERROR,
          requestId: requestIdValue,
        },
      });
      return;
    }
    logger.error({ err: error, requestId: requestIdValue }, 'unhandled HTTP error');
    res.status(500).json({
      error: { code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL, requestId: requestIdValue },
    });
  });

  return app;
}
