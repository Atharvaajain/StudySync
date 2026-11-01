import { Router } from 'express';
import {
  createRoomSchema,
  joinByCodeSchema,
  roomTasksQuerySchema,
  uuidSchema,
} from '@studysync/shared';
import { byIp, byUser, limiter, userIdOf, type HttpRateLimits } from '../../http/middleware';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import { toIso } from '../../lib/time';
import { parseOrThrow } from '../../lib/validate';
import type { MemberStatusService } from '../presence/memberStatusService';
import type { SessionService } from '../sessions/sessionService';
import type { TaskService } from '../tasks/taskService';
import type { RoomService } from './roomService';

const MIN = 60_000;

/** REST for rooms (API_DESIGN §5). Presence and room moves happen over the socket (join_room). */
export function roomsRoutes(deps: {
  rooms: RoomService;
  sessions: SessionService;
  tasks: TaskService;
  memberStatus: MemberStatusService;
  queue: KeyedQueue;
  clock: Clock;
  limits: HttpRateLimits;
}): Router {
  const { rooms, sessions, tasks, memberStatus, queue, clock, limits } = deps;
  const router = Router();

  /** I-06: a session that lives in another room blocks creating or joining (no side effects). */
  const assertSessionAllows = async (userId: string, roomId: string | null): Promise<void> => {
    const session = await queue.run(userId, () => sessions.refresh(userId));
    if (session?.roomId && session.roomId !== roomId) {
      throw new AppError('SESSION_IN_OTHER_ROOM', { session, roomName: session.roomName });
    }
  };
  const roomIdOf = (raw: unknown): string => {
    const parsed = uuidSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('NOT_FOUND');
    return parsed.data;
  };
  const memberRoom = async (userId: string, raw: unknown): Promise<string> => {
    const roomId = roomIdOf(raw);
    await rooms.assertMember(roomId, userId);
    return roomId;
  };

  router.get('/', async (_req, res) => {
    res.json({ items: await rooms.myRooms(userIdOf(res)) });
  });

  router.post('/', async (req, res) => {
    const userId = userIdOf(res);
    const { name } = parseOrThrow(createRoomSchema, req.body);
    await assertSessionAllows(userId, null);
    res.status(201).json(await rooms.create(userId, name));
  });

  router.post(
    '/join',
    limiter({ windowMs: MIN, limit: limits.joinPerUserMinute, key: byUser }),
    limiter({ windowMs: 60 * MIN, limit: limits.joinPerUserHour, key: byUser }),
    limiter({ windowMs: 60 * MIN, limit: limits.joinPerIpHour, key: byIp }),
    async (req, res) => {
      const userId = userIdOf(res);
      const { code } = parseOrThrow(joinByCodeSchema, req.body);
      const room = await rooms.joinByCode(userId, code, (roomId) =>
        assertSessionAllows(userId, roomId),
      );
      res.json(room);
    },
  );

  router.get('/:roomId', async (req, res) => {
    const userId = userIdOf(res);
    const roomId = await memberRoom(userId, req.params.roomId);
    res.json(await rooms.roomDto(roomId, userId));
  });

  router.get('/:roomId/members', async (req, res) => {
    const roomId = await memberRoom(userIdOf(res), req.params.roomId);
    res.json({ members: await memberStatus.members(roomId), serverNow: toIso(clock.now()) });
  });

  router.get('/:roomId/tasks', async (req, res) => {
    const roomId = await memberRoom(userIdOf(res), req.params.roomId);
    const { status } = parseOrThrow(roomTasksQuerySchema, req.query);
    res.json({ items: await tasks.listRoom(roomId, status) });
  });

  router.get('/:roomId/today', async (req, res) => {
    const roomId = await memberRoom(userIdOf(res), req.params.roomId);
    res.json(await rooms.today(roomId));
  });

  return router;
}
