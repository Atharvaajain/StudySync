/**
 * Composition root (ARCHITECTURE §10): wires the Clock, scheduler, stores and services.
 * Everything is injectable so tests can run the real server with a controlled clock.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOTYPE_ROOM } from '@studysync/shared';
import type { Env } from './config/env';
import { DomainEvents } from './events/domainEvents';
import { createHttpApp } from './http/app';
import { OffsetClock, systemClock, type Clock } from './lib/clock';
import { KeyedQueue } from './lib/keyedQueue';
import { createLogger, type Logger } from './lib/logger';
import { TimerScheduler } from './lib/scheduler';
import { MemberStatusService } from './modules/presence/memberStatusService';
import { PresenceStore } from './modules/presence/presenceStore';
import { RoomPresenceService } from './modules/presence/roomPresenceService';
import { RoomRegistry } from './modules/rooms/roomRegistry';
import { SessionService } from './modules/sessions/sessionService';
import { InMemorySessionStore } from './modules/sessions/sessionStore';
import { UserDirectory } from './modules/users/userDirectory';
import { createRealtime, type StudySyncIo } from './realtime/io';
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from './realtime/rateLimiter';

export interface CreateServerOptions {
  env: Env;
  clock?: Clock;
  logger?: Logger;
  rateLimits?: RateLimitConfig;
  newId?: () => string;
}

export interface StudySyncServer {
  env: Env;
  clock: Clock;
  logger: Logger;
  scheduler: TimerScheduler;
  store: InMemorySessionStore;
  sessions: SessionService;
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

  const scheduler = new TimerScheduler(clock, (err, key) =>
    logger.error({ err, key }, 'scheduled task failed'),
  );
  const queue = new KeyedQueue();
  const events = new DomainEvents();
  const rooms = new RoomRegistry([{ ...PROTOTYPE_ROOM, createdAt: clock.now() }]);
  const users = new UserDirectory();
  const presence = new PresenceStore();
  const store = new InMemorySessionStore(newId);
  const sessions = new SessionService({
    store,
    clock,
    rooms,
    scheduler,
    events,
    queue,
    newId,
    logger,
  });
  const memberStatus = new MemberStatusService({ presence, sessions, users, rooms });
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

  const app = createHttpApp({ env, clock, scheduler, logger });
  const httpServer = createServer(app);
  const io = createRealtime(httpServer, {
    presence,
    roomPresence,
    memberStatus,
    sessions,
    users,
    events,
    queue,
    logger,
    rateLimits: options.rateLimits ?? DEFAULT_RATE_LIMITS,
  });

  return {
    env,
    clock,
    logger,
    scheduler,
    store,
    sessions,
    presence,
    httpServer,
    io,
    listen(port, host = env.HOST) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve(httpServer.address() as AddressInfo));
      });
    },
    close() {
      scheduler.dispose();
      return new Promise((resolve) => {
        void io.close(() => resolve());
      });
    },
  };
}
