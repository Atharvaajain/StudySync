import { Router } from 'express';
import { z } from 'zod';
import { userIdOf } from '../../http/middleware';
import { parseOrThrow } from '../../lib/validate';
import type { TaskService } from './taskService';

const listQuery = z.strictObject({ status: z.enum(['TODO', 'DONE']).optional() });

export function tasksRoutes(tasks: TaskService): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const { status } = parseOrThrow(listQuery, req.query);
    res.json({ items: await tasks.list(userIdOf(res), status) });
  });
  return router;
}
