/**
 * Composition root (ARCHITECTURE §10): wires the Clock, database, scheduler, services, HTTP and
 * Socket.IO. Everything is injectable so tests can run the real server with a controlled clock.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from './config/env';
import { DomainEvents } from './events/domainEvents';
import { createHttpApp } from './http/app';
import {
  DEFAULT_HTTP_RATE_LIMITS,
  RELAXED_HTTP_RATE_LIMITS,
  type HttpRateLimits,
} from './http/middleware';
import { OffsetClock, systemClock, type Clock } from './lib/clock';
import { createPrisma, type Db } from './lib/db';
import { KeyedQueue } from './lib/keyedQueue';
import { createLogger, type Logger } from './lib/logger';
import { TimerScheduler } from './lib/scheduler';
import { AuthService } from './modules/auth/authService';
import { TokenService } from './modules/auth/tokens';
import { MemberStatusService } from './modules/presence/memberStatusService';
import { PresenceStore } from './modules/presence/presenceStore';
import { RoomPresenceService } from './modules/presence/roomPresenceService';
import { RoomRegistry } from './modules/rooms/roomRegistry';
import { SessionService } from './modules/sessions/sessionService';
import { StatsService } from './modules/stats/statsService';
import { TaskService } from './modules/tasks/taskService';
import { UserDirectory } from './modules/users/userDirectory';
import { UserService } from './modules/users/userService';
import { createRealtime, type StudySyncIo } from './realtime/io';
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from './realtime/rateLimiter';

export interface CreateServerOptions {
  env: Env;
  clock?: Clock;
  logger?: Logger;
  db?: Db;
  rateLimits?: RateLimitConfig;
  httpRateLimits?: HttpRateLimits;
  newId?: () => string;
}

export interface StudySyncServer {
  env: Env;
  clock: Clock;
  logger: Logger;
  db: Db;
  scheduler: TimerScheduler;
  sessions: SessionService;
  tasks: TaskService;
  stats: StatsService;
  presence: PresenceStore;
  httpServer: HttpServer;
  io: StudySyncIo;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createStudySyncServer(options: CreateServerOptions): StudySyncServer {
  const { env } = options;
  const clock = options.clock ?? (env.ENABLE_TEST_CLOCK ? new OffsetClock() : systemClock);
  const logger = options.logger ?? createLogger(env.LOG_LEVEL);
  const newId = options.newId ?? randomUUID;
  const ownsDb = options.db === undefined;
  const db = options.db ?? createPrisma(env.DATABASE_URL);

  const scheduler = new TimerScheduler(clock, (err, key) =>
    logger.error({ err, key }, 'scheduled task failed'),
  );
  const queue = new KeyedQueue();
  const events = new DomainEvents();
  const directory = new UserDirectory();
  const presence = new PresenceStore();
  const tokens = new TokenService(env, clock);
  const users = new UserService(db, directory);
  const auth = new AuthService({ db, env, clock, tokens, users });
  const rooms = new RoomRegistry(db, clock);
  const sessions = new SessionService({ db, clock, scheduler, events, queue, newId, logger });
  const tasks = new TaskService({ db, clock, events });
  const stats = new StatsService({ db, clock });
  const memberStatus = new MemberStatusService({ presence, sessions, users: directory, rooms });
  const roomPresence = new RoomPresenceService({
    presence,
    memberStatus,
    sessions,
    rooms,
    scheduler,
    events,
    queue,
    clock,
  });

  const httpRateLimits =
    options.httpRateLimits ??
    (env.RELAX_RATE_LIMITS ? RELAXED_HTTP_RATE_LIMITS : DEFAULT_HTTP_RATE_LIMITS);
  const app = createHttpApp({
    env,
    clock,
    scheduler,
    logger,
    db,
    queue,
    tokens,
    auth,
    users,
    tasks,
    sessions,
    stats,
    rateLimits: httpRateLimits,
  });
  const httpServer = createServer(app);
  const io = createRealtime(httpServer, {
    db,
    tokens,
    presence,
    roomPresence,
    memberStatus,
    sessions,
    tasks,
    users: directory,
    events,
    queue,
    scheduler,
    logger,
    rateLimits: options.rateLimits ?? DEFAULT_RATE_LIMITS,
  });

  return {
    env,
    clock,
    logger,
    db,
    scheduler,
    sessions,
    tasks,
    stats,
    presence,
    httpServer,
    io,
    listen(port, host = env.HOST) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve(httpServer.address() as AddressInfo));
      });
    },
    async close() {
      scheduler.dispose();
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      if (ownsDb) await db.$disconnect();
    },
  };
}
