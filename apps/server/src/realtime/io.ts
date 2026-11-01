/**
 * Socket.IO gateway (ARCHITECTURE §12). Event names are the spec's names (API_DESIGN §7–§8).
 *
 * Handshake: JWT access token in `auth.token` (HS256 pinned, iss/aud). Failures surface as
 * `connect_error` with UNAUTHENTICATED / TOKEN_EXPIRED / TOO_MANY_CONNECTIONS.
 * Pipeline for every client event: rate limit → Zod validation (strict) → per-user queue →
 * service → ack. Pushes are emitted from committed domain events only.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import {
  ERROR_MESSAGES,
  MAX_SOCKETS_PER_USER,
  authRenewSchema,
  endStudySchema,
  joinRoomSchema,
  leaveRoomSchema,
  resumeStudySchema,
  roomChannel,
  setSessionTaskSchema,
  startStudySchema,
  syncStateSchema,
  takeBreakSchema,
  taskAddSchema,
  taskDeleteSchema,
  taskToggleSchema,
  taskUpdateSchema,
  userChannel,
  type AckResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@studysync/shared';
import type { DomainEvents } from '../events/domainEvents';
import type { Db } from '../lib/db';
import { AppError, toAckError } from '../lib/errors';
import type { KeyedQueue } from '../lib/keyedQueue';
import type { Logger } from '../lib/logger';
import type { DeadlineScheduler } from '../lib/scheduler';
import { toIso } from '../lib/time';
import type { TokenService } from '../modules/auth/tokens';
import type { MemberStatusService } from '../modules/presence/memberStatusService';
import type { PresenceStore } from '../modules/presence/presenceStore';
import type { RoomPresenceService } from '../modules/presence/roomPresenceService';
import type { PresenceContext, SessionService } from '../modules/sessions/sessionService';
import type { TaskService } from '../modules/tasks/taskService';
import type { UserDirectory } from '../modules/users/userDirectory';
import { SocketRateLimiter, type RateBucket, type RateLimitConfig } from './rateLimiter';

export interface SocketData {
  userId: string;
  tokenExpiresAt: number;
}

export type StudySyncIo = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type StudySyncSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface RealtimeDeps {
  db: Db;
  tokens: TokenService;
  presence: PresenceStore;
  roomPresence: RoomPresenceService;
  memberStatus: MemberStatusService;
  sessions: SessionService;
  tasks: TaskService;
  users: UserDirectory;
  events: DomainEvents;
  queue: KeyedQueue;
  scheduler: DeadlineScheduler;
  logger: Logger;
  rateLimits: RateLimitConfig;
}

const authExpiryKey = (socketId: string): string => `auth-expiry:${socketId}`;

export function createRealtime(httpServer: HttpServer, deps: RealtimeDeps): StudySyncIo {
  const io: StudySyncIo = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });
  const limiter = new SocketRateLimiter(deps.rateLimits);

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token = auth?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      next(new Error('UNAUTHENTICATED'));
      return;
    }
    let claims: { userId: string; expiresAt: number };
    try {
      claims = deps.tokens.verifyAccess(token);
    } catch (error) {
      next(new Error(error instanceof AppError ? error.code : 'UNAUTHENTICATED'));
      return;
    }
    const { userId } = claims;
    if (deps.presence.socketCount(userId) >= MAX_SOCKETS_PER_USER) {
      next(new Error('TOO_MANY_CONNECTIONS'));
      return;
    }
    // Load the user and their committed session before `connection`, so the CONNECT
    // `session_state` is authoritative (F-32).
    deps.queue
      .run(userId, async () => {
        const user = await deps.db.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true },
        });
        if (!user) throw new AppError('UNAUTHENTICATED');
        deps.users.upsert(user.id, user.name);
        await deps.sessions.refresh(userId);
      })
      .then(
        () => {
          socket.data = { userId, tokenExpiresAt: claims.expiresAt };
          next();
        },
        (error: unknown) => {
          if (!(error instanceof AppError)) deps.logger.error({ err: error }, 'handshake failed');
          next(new Error(error instanceof AppError ? error.code : 'INTERNAL'));
        },
      );
  });

  io.on('connection', (socket) => registerConnection(io, socket, deps, limiter));
  subscribeEmitter(io, deps);
  return io;
}

function registerConnection(
  io: StudySyncIo,
  socket: StudySyncSocket,
  deps: RealtimeDeps,
  limiter: SocketRateLimiter,
): void {
  const { userId } = socket.data;
  const { sessions, tasks, roomPresence, presence, queue, logger, scheduler, tokens } = deps;

  // Re-checked here: parallel handshakes may have passed the middleware check together.
  if (presence.socketCount(userId) >= MAX_SOCKETS_PER_USER) {
    socket.disconnect(true);
    return;
  }
  presence.addSocket(userId, socket.id);
  void socket.join(userChannel(userId));
  // F-32: the refresh-proof timer — every (re)connect receives the authoritative state.
  socket.emit('session_state', sessions.statePayload(userId, 'CONNECT'));

  // RT-9: an expired socket gets `auth_expired` and is disconnected (unless renewed).
  const scheduleExpiry = (expiresAt: number): void => {
    scheduler.schedule(authExpiryKey(socket.id), expiresAt, () => {
      socket.emit('auth_expired', {});
      socket.disconnect(true);
    });
  };
  scheduleExpiry(socket.data.tokenExpiresAt);

  const presenceContext = (): PresenceContext => ({
    userPresenceRoomId: presence.roomOfUser(userId),
    callerRoomId: presence.roomOfSocket(socket.id),
  });

  /** Validated, rate-limited, per-user-serialized handler with a typed ack. */
  function on<S extends z.ZodType, R>(
    event: keyof ClientToServerEvents,
    bucket: RateBucket,
    schema: S,
    run: (data: z.output<S>) => R | Promise<R>,
    options: { sessionDetails: boolean } = { sessionDetails: false },
  ): void {
    const listener = (raw: unknown, ack: unknown): void => {
      const reply =
        typeof ack === 'function' ? (ack as (r: AckResponse<R>) => void) : (): void => undefined;
      if (!limiter.take(socket.id, bucket)) {
        reply({ ok: false, error: { code: 'RATE_LIMITED', message: ERROR_MESSAGES.RATE_LIMITED } });
        return;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        const details: Record<string, unknown> = { issues };
        if (options.sessionDetails) details.session = sessions.activeSessionDto(userId);
        reply({ ok: false, error: new AppError('VALIDATION_ERROR', details).toAckError() });
        return;
      }
      queue
        .run(userId, () => run(parsed.data))
        .then(
          (data) => reply({ ok: true, data }),
          (error: unknown) => {
            if (!(error instanceof AppError))
              logger.error({ err: error, event, userId }, 'handler failed');
            reply({ ok: false, error: toAckError(error) });
          },
        );
    };
    (socket as unknown as { on(e: string, l: (raw: unknown, ack: unknown) => void): void }).on(
      event,
      listener,
    );
  }

  // ── rooms (Phase 0 prototype room) ──

  on('join_room', 'room', joinRoomSchema, async ({ roomId }) => {
    const { result, previousRoomId } = await roomPresence.join(userId, socket.id, roomId);
    if (previousRoomId) void socket.leave(roomChannel(previousRoomId));
    void socket.join(roomChannel(roomId));
    return result;
  });

  on('leave_room', 'room', leaveRoomSchema, async ({ roomId }) => {
    await roomPresence.leave(userId, roomId);
    io.in(userChannel(userId)).socketsLeave(roomChannel(roomId));
    return {} as Record<string, never>;
  });

  on('sync_state', 'sync', syncStateSchema, () => sessions.statePayload(userId, 'SYNC'));

  on('auth_renew', 'sync', authRenewSchema, ({ token }) => {
    const claims = tokens.verifyAccess(token);
    if (claims.userId !== userId) throw new AppError('UNAUTHENTICATED');
    socket.data.tokenExpiresAt = claims.expiresAt;
    scheduleExpiry(claims.expiresAt);
    return { expiresAt: toIso(claims.expiresAt) };
  });

  // ── timer (each user's own, independent timer; R1) ──

  on(
    'start_study',
    'timer',
    startStudySchema,
    async (d) => {
      const r = await sessions.execute(userId, presenceContext(), {
        type: 'START',
        commandId: d.commandId,
        roomId: d.roomId,
        taskId: d.taskId,
      });
      return { session: r.session! };
    },
    { sessionDetails: true },
  );

  on(
    'take_break',
    'timer',
    takeBreakSchema,
    async (d) => {
      const r = await sessions.execute(userId, presenceContext(), {
        type: 'TAKE_BREAK',
        commandId: d.commandId,
        sessionId: d.sessionId,
        durationMinutes: d.durationMinutes,
      });
      return { session: r.session! };
    },
    { sessionDetails: true },
  );

  on(
    'resume_study',
    'timer',
    resumeStudySchema,
    async (d) => {
      const r = await sessions.execute(userId, presenceContext(), {
        type: 'RESUME',
        commandId: d.commandId,
        sessionId: d.sessionId,
      });
      return { session: r.session! };
    },
    { sessionDetails: true },
  );

  on(
    'end_study',
    'timer',
    endStudySchema,
    async (d) => {
      const r = await sessions.execute(userId, presenceContext(), {
        type: 'END',
        commandId: d.commandId,
        sessionId: d.sessionId,
      });
      return { summary: r.summary! };
    },
    { sessionDetails: true },
  );

  on(
    'set_session_task',
    'timer',
    setSessionTaskSchema,
    async (d) => {
      const r = await sessions.execute(userId, presenceContext(), {
        type: 'SET_TASK',
        commandId: d.commandId,
        sessionId: d.sessionId,
        taskId: d.taskId,
      });
      return { session: r.session! };
    },
    { sessionDetails: true },
  );

  // ── personal tasks ──

  on('task_add', 'task', taskAddSchema, async (d) => ({ task: await tasks.add(userId, d) }));
  on('task_toggle', 'task', taskToggleSchema, async (d) => ({
    task: await tasks.toggle(userId, d.taskId, d.done),
  }));
  on('task_update', 'task', taskUpdateSchema, async (d) => ({
    task: await tasks.update(userId, d),
  }));
  on('task_delete', 'task', taskDeleteSchema, async (d) => {
    await tasks.remove(userId, d.taskId);
    return {} as Record<string, never>;
  });

  socket.on('disconnect', () => {
    limiter.forget(socket.id);
    scheduler.cancel(authExpiryKey(socket.id));
    void queue.run(userId, () => roomPresence.socketDisconnected(socket.id));
  });
}

/** Committed domain events → Socket.IO pushes (ARCHITECTURE §12.4). */
function subscribeEmitter(io: StudySyncIo, deps: RealtimeDeps): void {
  deps.events.subscribe((event) => {
    switch (event.type) {
      case 'session_changed':
        io.to(userChannel(event.userId)).emit(
          'session_state',
          deps.sessions.statePayload(event.userId, event.cause),
        );
        return;
      case 'member_status_changed':
        io.to(roomChannel(event.roomId)).emit('status_changed', {
          roomId: event.roomId,
          member: deps.memberStatus.next(event.roomId, event.userId),
        });
        return;
      case 'member_joined':
        io.to(roomChannel(event.roomId)).emit('member_joined', {
          roomId: event.roomId,
          member: deps.memberStatus.next(event.roomId, event.userId),
        });
        return;
      case 'member_left': {
        const member = deps.memberStatus.next(event.roomId, event.userId); // OFFLINE
        io.to(roomChannel(event.roomId)).emit('member_left', {
          roomId: event.roomId,
          userId: event.userId,
        });
        io.to(roomChannel(event.roomId)).emit('status_changed', { roomId: event.roomId, member });
        return;
      }
      case 'personal_task_changed':
        io.to(userChannel(event.userId)).emit(
          'personal_task_updated',
          event.task
            ? { action: event.action, task: event.task, taskId: event.taskId }
            : { action: event.action, taskId: event.taskId },
        );
        return;
    }
  });
}
