import { Router } from 'express';
import { historyQuerySchema, uuidSchema } from '@studysync/shared';
import { userIdOf } from '../../http/middleware';
import type { Clock } from '../../lib/clock';
import type { KeyedQueue } from '../../lib/keyedQueue';
import { toIso } from '../../lib/time';
import { parseOrThrow } from '../../lib/validate';
import type { SessionService } from './sessionService';

export function sessionsRoutes(deps: {
  sessions: SessionService;
  queue: KeyedQueue;
  clock: Clock;
}): Router {
  const { sessions, queue, clock } = deps;
  const router = Router();

  // Refresh-proof fallback (F-32): the committed state, read on the user's queue.
  router.get('/current', async (_req, res) => {
    const userId = userIdOf(res);
    const session = await queue.run(userId, () => sessions.refresh(userId));
    const { lastAutoSaved } = sessions.statePayload(userId, 'SYNC');
    res.json({ session, lastAutoSaved, serverNow: toIso(clock.now()) });
  });

  router.get('/', async (req, res) => {
    const query = parseOrThrow(historyQuerySchema, req.query);
    res.json(await sessions.history(userIdOf(res), query));
  });

  router.get('/:sessionId/summary', async (req, res) => {
    const sessionId = parseOrThrow(uuidSchema, req.params.sessionId);
    res.json(await sessions.summaryFor(userIdOf(res), sessionId));
  });

  // Acknowledge the "session saved" notice (owner only, idempotent).
  router.post('/:sessionId/summary-seen', async (req, res) => {
    const userId = userIdOf(res);
    const sessionId = parseOrThrow(uuidSchema, req.params.sessionId);
    await queue.run(userId, () => sessions.markSummarySeen(userId, sessionId));
    res.status(204).end();
  });

  return router;
}
