/**
 * Composition root (ARCHITECTURE §10): wires the Clock, database, scheduler, services, HTTP and
 * Socket.IO. Everything is injectable so tests can run the real server with a controlled clock.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SWEEP_INTERVAL_MS } from '@studysync/shared';
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
import { RoomService } from './modules/rooms/roomService';
import { Maintenance } from './modules/sessions/maintenance';
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
  /** Room code generator (tests force collisions with it, CT-11). */
  newRoomCode?: () => string;
  /** Sweeper / lease cadence; 0 = no automatic ticks (tests call `maintenance.tick()`). */
  maintenanceIntervalMs?: number;
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
  rooms: RoomService;
  presence: PresenceStore;
  maintenance: Maintenance;
  httpServer: HttpServer;
  io: StudySyncIo;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  /** Crash simulation (tests): stop processing without handling any disconnect. */
  halt(): Promise<void>;
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
  const rooms = new RoomService({
    db,
    clock,
    ...(options.newRoomCode ? { newCode: options.newRoomCode } : {}),
  });
  const sessions = new SessionService({
    db,
    clock,
    scheduler,
    events,
    queue,
    newId,
    logger,
    isLive: (userId, roomId) => presence.isLive(userId, roomId),
  });
  const maintenance = new Maintenance({ db, clock, presence, sessions, queue, logger });
  let halted = false;
  const tasks = new TaskService({ db, clock, events });
  const stats = new StatsService({ db, clock });
  const memberStatus = new MemberStatusService({ presence, sessions, users: directory, rooms });
  const roomPresence = new RoomPresenceService({
    presence,
    memberStatus,
    sessions,
    rooms,
    tasks,
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
    rooms,
    memberStatus,
    maintenance,
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
    isHalted: () => halted,
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
    rooms,
    presence,
    maintenance,
    httpServer,
    io,
    listen(port, host = env.HOST) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const interval = options.maintenanceIntervalMs ?? SWEEP_INTERVAL_MS;
          if (interval > 0) maintenance.start(interval); // also sweeps once at boot (§13.9)
          resolve(httpServer.address() as AddressInfo);
        });
      });
    },
    async close() {
      // Shutdown is not a user disconnect: sessions stay live through a restart (the lease
      // and the clients' reconnect decide, §13.9). Pending work finishes before the DB closes.
      halted = true;
      maintenance.stop();
      scheduler.dispose();
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      await queue.drain();
      if (ownsDb) await db.$disconnect();
    },
    async halt() {
      halted = true;
      maintenance.stop();
      scheduler.dispose();
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      await queue.drain();
    },
  };
}
