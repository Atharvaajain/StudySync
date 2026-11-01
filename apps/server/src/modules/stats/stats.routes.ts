import { Router } from 'express';
import {
  dailyStatsQuerySchema,
  heatmapQuerySchema,
  periodStatsQuerySchema,
} from '@studysync/shared';
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
  router.get('/periods', async (req, res) => {
    const { granularity, from, to } = parseOrThrow(periodStatsQuerySchema, req.query);
    res.json(await stats.periods(userIdOf(res), granularity, from, to));
  });
  router.get('/heatmap', async (req, res) => {
    const { from, to } = parseOrThrow(heatmapQuerySchema, req.query);
    res.json(await stats.heatmap(userIdOf(res), from, to));
  });
  router.get('/streak', async (_req, res) => {
    res.json(await stats.streak(userIdOf(res)));
  });
  return router;
}
