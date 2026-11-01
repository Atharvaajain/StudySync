import { Router } from 'express';
import { updateProfileSchema } from '@studysync/shared';
import { userIdOf } from '../../http/middleware';
import { parseOrThrow } from '../../lib/validate';
import type { UserService } from './userService';

export function usersRoutes(users: UserService): Router {
  const router = Router();
  router.get('/me', async (_req, res) => {
    res.json(await users.getMe(userIdOf(res)));
  });
  router.patch('/me', async (req, res) => {
    const patch = parseOrThrow(updateProfileSchema, req.body);
    res.json(await users.updateMe(userIdOf(res), patch));
  });
  return router;
}
