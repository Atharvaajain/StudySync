/**
 * Realtime test harness (TESTING_STRATEGY §4, §5.6): the real server in-process on an
 * ephemeral port, backed by the real PostgreSQL test database, a frozen ManualClock that only
 * moves when advanced, and real socket.io-client connections authenticated with real JWTs.
 */
import { randomUUID } from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  type AckResponse,
  type BreakMinutes,
  type ClientToServerEvents,
  type JoinRoomResult,
  type MemberStatusDto,
  type ServerToClientEvents,
  type SessionDto,
  type SessionStatePayload,
  type SessionSummaryDto,
} from '@studysync/shared';
import type { HttpRateLimits } from '../../src/http/middleware';
import { ManualClock } from '../../src/lib/clock';
import { createLogger } from '../../src/lib/logger';
import { TokenService } from '../../src/modules/auth/tokens';
import type { RateLimitConfig } from '../../src/realtime/rateLimiter';
import { createStudySyncServer, type StudySyncServer } from '../../src/server';
import { createUser, resetDb, testDb, testEnv } from './db';

/** The Phase 0 room, now a real room: every harness user is made a member on connect. */
export const ROOM = {
  id: '5e1f0d5a-0000-4000-8000-000000000001',
  name: 'DSA Night Study',
  code: 'DSA7K2',
} as const;
export const ROOM_ID = ROOM.id;
export const START = Date.parse('2026-11-01T10:00:00.000Z');
export const MIN = 60_000;

export const NO_LIMITS: RateLimitConfig = {
  timer: { capacity: 10_000, perMs: 1_000 },
  task: { capacity: 10_000, perMs: 1_000 },
  room: { capacity: 10_000, perMs: 1_000 },
  sync: { capacity: 10_000, perMs: 1_000 },
};

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type EventName = keyof ServerToClientEvents;
type EventPayload<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

export interface Received {
  event: EventName;
  payload: unknown;
}

export class TestClient {
  readonly received: Received[] = [];
  readonly members = new Map<string, MemberStatusDto>();

  constructor(
    readonly socket: ClientSocket,
    readonly userId: string,
    readonly name: string,
  ) {
    socket.onAny((event: EventName, payload: unknown) => {
      this.received.push({ event, payload });
      if (event === 'member_joined' || event === 'status_changed') {
        this.trackMember((payload as { member: MemberStatusDto }).member);
      }
    });
  }

  /** Index to pass to `waitFor` / `since` so no event is missed. */
  mark(): number {
    return this.received.length;
  }

  since<E extends EventName>(mark: number, event: E): EventPayload<E>[] {
    return this.received
      .slice(mark)
      .filter((r) => r.event === event)
      .map((r) => r.payload as EventPayload<E>);
  }

  all<E extends EventName>(event: E): EventPayload<E>[] {
    return this.since(0, event);
  }

  waitFor<E extends EventName>(
    event: E,
    predicate: (payload: EventPayload<E>) => boolean = () => true,
    fromMark = 0,
    timeoutMs = 2_000,
  ): Promise<EventPayload<E>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const hit = this.since(fromMark, event).find(predicate);
        if (hit !== undefined) {
          resolve(hit);
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(() => {
        this.socket.offAny(listener);
        reject(new Error(`timeout waiting for ${event} (${this.name})`));
      }, timeoutMs);
      const listener = () => {
        // onAny listeners run in registration order: the buffer already has the event.
        if (check()) {
          clearTimeout(timer);
          this.socket.offAny(listener);
        }
      };
      this.socket.onAny(listener);
    });
  }

  async call<E extends keyof ClientToServerEvents>(
    event: E,
    payload: unknown,
  ): Promise<
    AckResponse<
      Parameters<Parameters<ClientToServerEvents[E]>[1]>[0] extends AckResponse<infer T> ? T : never
    >
  > {
    const emit = this.socket.timeout(5_000).emitWithAck as (
      e: string,
      p: unknown,
    ) => Promise<never>;
    return emit.call(this.socket.timeout(5_000), event, payload);
  }

  /** A sync round trip: every push emitted before it has been received when it resolves. */
  async sync(): Promise<SessionStatePayload> {
    return this.ok(await this.call('sync_state', {}));
  }

  async join(roomId: string = ROOM_ID): Promise<JoinRoomResult> {
    const result = this.ok(await this.call('join_room', { roomId }));
    for (const m of result.members) this.trackMember(m);
    return result;
  }

  /** Start Study in the prototype room (default) or solo (`null`). */
  async start(roomId: string | null = ROOM_ID): Promise<SessionDto> {
    return this.ok(await this.call('start_study', { commandId: randomUUID(), roomId })).session;
  }

  async takeBreak(sessionId: string, durationMinutes: BreakMinutes): Promise<SessionDto> {
    return this.ok(
      await this.call('take_break', { commandId: randomUUID(), sessionId, durationMinutes }),
    ).session;
  }

  async resume(sessionId: string): Promise<SessionDto> {
    return this.ok(await this.call('resume_study', { commandId: randomUUID(), sessionId })).session;
  }

  async end(sessionId: string): Promise<SessionSummaryDto> {
    return this.ok(await this.call('end_study', { commandId: randomUUID(), sessionId })).summary;
  }

  /** The member's status as this client last saw it (version-guarded, like the web client). */
  statusOf(userId: string): MemberStatusDto | undefined {
    return this.members.get(userId);
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.disconnected) return resolve();
      this.socket.once('disconnect', () => resolve());
      this.socket.disconnect();
    });
  }

  ok<T>(res: AckResponse<T>): T {
    if (!res.ok)
      throw new Error(`${this.name}: unexpected ${res.error.code}: ${res.error.message}`);
    return res.data;
  }

  private trackMember(member: MemberStatusDto): void {
    const existing = this.members.get(member.user.id);
    if (!existing || member.version >= existing.version) this.members.set(member.user.id, member);
  }
}

export interface Harness {
  server: StudySyncServer;
  clock: ManualClock;
  url: string;
  tokens: TokenService;
  /** Move the server clock forward and fire due deadlines (break-over pushes, display grace). */
  advance(ms: number): void;
  /**
   * Creates a user (unless `userId` is given) and connects a socket with a real JWT. New users
   * become members of the test room unless `member: false`.
   */
  connect(
    name: string,
    options?: { userId?: string; timezone?: string; member?: boolean },
  ): Promise<TestClient>;
  /** Crash the server (no disconnect processed) and start a fresh instance on the same DB. */
  crashAndRestart(): Promise<void>;
  /** Connect with arbitrary handshake auth; resolves with the connect_error message. */
  connectExpectingError(auth: unknown): Promise<string>;
  /** A valid access token for `userId` (REST calls). */
  tokenFor(userId: string): string;
  close(): Promise<void>;
}

/** Starts the server on a clean database. */
export async function startHarness(
  options: {
    rateLimits?: RateLimitConfig;
    httpRateLimits?: HttpRateLimits;
    start?: number;
    accessTokenTtlSec?: number;
  } = {},
): Promise<Harness> {
  const db = testDb();
  await resetDb(db);
  const ensureMember = async (userId: string): Promise<void> => {
    await db.room.upsert({
      where: { id: ROOM.id },
      update: {},
      create: { ...ROOM, createdById: userId },
    });
    await db.roomMember.upsert({
      where: { roomId_userId: { roomId: ROOM.id, userId } },
      update: {},
      create: { roomId: ROOM.id, userId },
    });
  };
  const clock = new ManualClock(options.start ?? START);
  // Long-lived tokens by default: timer tests fast-forward the clock by tens of minutes.
  const env = testEnv({ ACCESS_TOKEN_TTL_SEC: String(options.accessTokenTtlSec ?? 86_400) });
  const boot = async () => {
    const instance = createStudySyncServer({
      env,
      clock,
      db,
      logger: createLogger('silent'),
      rateLimits: options.rateLimits ?? NO_LIMITS,
      maintenanceIntervalMs: 0, // tests run `maintenance.tick()` explicitly
      ...(options.httpRateLimits ? { httpRateLimits: options.httpRateLimits } : {}),
    });
    const address = await instance.listen(0, '127.0.0.1');
    return { instance, url: `http://127.0.0.1:${address.port}` };
  };
  let { instance: server, url } = await boot();
  const tokens = new TokenService(env, clock);
  const clients: TestClient[] = [];

  const open = (auth: unknown): ClientSocket =>
    connectClient(url, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      auth: auth as Record<string, unknown>,
    });

  const harness: Harness = {
    server,
    clock,
    url,
    tokens,
    advance(ms) {
      clock.advance(ms);
      server.scheduler.runDue();
    },
    async connect(name, opts = {}) {
      let userId = opts.userId;
      if (!userId) {
        userId = (await createUser(db, { name, timezone: opts.timezone ?? 'UTC' })).id;
        if (opts.member !== false) await ensureMember(userId);
      }
      const socket = open({ token: tokens.signAccess(userId).token });
      const client = new TestClient(socket, userId, name);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err) => reject(err));
        socket.connect();
      });
      // The server sends session_state on every connect (F-32).
      await client.waitFor('session_state', (p) => p.cause === 'CONNECT');
      clients.push(client);
      return client;
    },
    connectExpectingError(auth) {
      const socket = open(auth);
      return new Promise<string>((resolve, reject) => {
        socket.once('connect', () => {
          socket.disconnect();
          reject(new Error('connected unexpectedly'));
        });
        socket.once('connect_error', (err) => {
          socket.disconnect();
          resolve(err.message);
        });
        socket.connect();
      });
    },
    tokenFor(userId) {
      return tokens.signAccess(userId).token;
    },
    async crashAndRestart() {
      await server.halt();
      ({ instance: server, url } = await boot());
      harness.server = server;
      harness.url = url;
    },
    async close() {
      await Promise.all(clients.map((c) => c.disconnect()));
      await server.close();
    },
  };
  return harness;
}

/** Two users present in the room. */
export async function twoInRoom(h: Harness): Promise<[TestClient, TestClient]> {
  const a = await h.connect('Alice');
  const b = await h.connect('Bob');
  await a.join();
  await b.join();
  await a.sync();
  return [a, b];
}

export const elapsedAt = (s: SessionDto, serverNowIso: string): number =>
  s.studyMsClosed +
  (s.currentSegmentStartedAt
    ? Date.parse(serverNowIso) - Date.parse(s.currentSegmentStartedAt)
    : 0);
