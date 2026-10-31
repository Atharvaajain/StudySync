/**
 * Socket.IO gateway (ARCHITECTURE §12). Event names are the spec's names (API_DESIGN §7–§8).
 *
 * Pipeline for every client event: rate limit → Zod validation (strict) → per-user queue →
 * service → ack. Pushes are emitted from committed domain events only.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import {
  ERROR_MESSAGES,
  MAX_SOCKETS_PER_USER,
  endStudySchema,
  joinRoomSchema,
  leaveRoomSchema,
  prototypeIdentitySchema,
  resumeStudySchema,
  roomChannel,
  startStudySchema,
  syncStateSchema,
  takeBreakSchema,
  userChannel,
  type AckResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@studysync/shared';
import type { DomainEvents } from '../events/domainEvents';
import { AppError, toAckError } from '../lib/errors';
import type { KeyedQueue } from '../lib/keyedQueue';
import type { Logger } from '../lib/logger';
import type { MemberStatusService } from '../modules/presence/memberStatusService';
import type { PresenceStore } from '../modules/presence/presenceStore';
import type { RoomPresenceService } from '../modules/presence/roomPresenceService';
import type { PresenceContext, SessionService } from '../modules/sessions/sessionService';
import type { UserDirectory } from '../modules/users/userDirectory';
import { SocketRateLimiter, type RateBucket, type RateLimitConfig } from './rateLimiter';

export interface SocketData {
  userId: string;
  name: string;
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
  presence: PresenceStore;
  roomPresence: RoomPresenceService;
  memberStatus: MemberStatusService;
  sessions: SessionService;
  users: UserDirectory;
  events: DomainEvents;
  queue: KeyedQueue;
  logger: Logger;
  rateLimits: RateLimitConfig;
}

export function createRealtime(httpServer: HttpServer, deps: RealtimeDeps): StudySyncIo {
  const io: StudySyncIo = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });
  const limiter = new SocketRateLimiter(deps.rateLimits);

  // PHASE 0 ONLY — prototype identity (no authentication). Phase 1 replaces this with JWT.
  io.use((socket, next) => {
    const parsed = prototypeIdentitySchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error('UNAUTHENTICATED'));
    const { userId, name } = parsed.data;
    if (deps.presence.socketCount(userId) >= MAX_SOCKETS_PER_USER) {
      return next(new Error('TOO_MANY_CONNECTIONS'));
    }
    deps.presence.addSocket(userId, socket.id);
    deps.users.upsert(userId, name);
    socket.data = { userId, name };
    next();
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
  const { sessions, roomPresence, presence, queue, logger } = deps;

  void socket.join(userChannel(userId));
  // F-32: the refresh-proof timer — every (re)connect receives the authoritative state.
  socket.emit('session_state', sessions.statePayload(userId, 'CONNECT'));

  const presenceContext = (): PresenceContext => ({
    userPresenceRoomId: presence.roomOfUser(userId),
    callerRoomId: presence.roomOfSocket(socket.id),
  });

  /** Validated, rate-limited, per-user-serialized handler with a typed ack. */
  function on<S extends z.ZodType, R>(
    event: keyof ClientToServerEvents,
    bucket: RateBucket,
    schema: S,
    run: (data: z.output<S>) => R,
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

  on('join_room', 'room', joinRoomSchema, ({ roomId }) => {
    const { result, previousRoomId } = roomPresence.join(userId, socket.id, roomId);
    if (previousRoomId) void socket.leave(roomChannel(previousRoomId));
    void socket.join(roomChannel(roomId));
    return result;
  });

  on('leave_room', 'room', leaveRoomSchema, ({ roomId }) => {
    roomPresence.leave(userId, roomId);
    io.in(userChannel(userId)).socketsLeave(roomChannel(roomId));
    return {} as Record<string, never>;
  });

  on('sync_state', 'sync', syncStateSchema, () => sessions.statePayload(userId, 'SYNC'));

  on(
    'start_study',
    'timer',
    startStudySchema,
    (d) => {
      const r = sessions.execute(userId, presenceContext(), {
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
    (d) => {
      const r = sessions.execute(userId, presenceContext(), {
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
    (d) => {
      const r = sessions.execute(userId, presenceContext(), {
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
    (d) => {
      const r = sessions.execute(userId, presenceContext(), {
        type: 'END',
        commandId: d.commandId,
        sessionId: d.sessionId,
      });
      return { summary: r.summary! };
    },
    { sessionDetails: true },
  );

  socket.on('disconnect', () => {
    limiter.forget(socket.id);
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
    }
  });
}
