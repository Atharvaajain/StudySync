import { Router } from 'express';
import { dailyStatsQuerySchema } from '@studysync/shared';
import { userIdOf } from '../../http/middleware';
import { parseOrThrow } from '../../lib/validate';
import type { StatsService } from './statsService';

export function statsRoutes(stats: StatsService): Router {
  const router = Router();
  router.get('/today', async (_req, res) => {
    res.json(await stats.today(userIdOf(res)));
  });
  router.get('/daily', async (req, res) => {
    const { from, to } = parseOrThrow(dailyStatsQuerySchema, req.query);
    res.json(await stats.daily(userIdOf(res), from, to));
  });
  router.get('/streak', async (_req, res) => {
    res.json(await stats.streak(userIdOf(res)));
  });
  return router;
}
