/**
 * Realtime test harness (TESTING_STRATEGY §4, §5.6): the real server in-process on an
 * ephemeral port, a frozen ManualClock that only moves when advanced, and real
 * socket.io-client connections acting as browsers.
 */
import { randomUUID } from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  PROTOTYPE_ROOM,
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
import { loadEnv } from '../../src/config/env';
import { ManualClock } from '../../src/lib/clock';
import { createLogger } from '../../src/lib/logger';
import type { RateLimitConfig } from '../../src/realtime/rateLimiter';
import { createStudySyncServer, type StudySyncServer } from '../../src/server';

export const ROOM_ID = PROTOTYPE_ROOM.id;
export const START = Date.parse('2026-11-01T10:00:00.000Z');
export const MIN = 60_000;

const NO_LIMITS: RateLimitConfig = {
  timer: { capacity: 10_000, perMs: 1_000 },
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

  async join(): Promise<JoinRoomResult> {
    const result = this.ok(await this.call('join_room', { roomId: ROOM_ID }));
    for (const m of result.members) this.trackMember(m);
    return result;
  }

  async start(): Promise<SessionDto> {
    return this.ok(await this.call('start_study', { commandId: randomUUID(), roomId: ROOM_ID }))
      .session;
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
  /** Move the server clock forward and fire due deadlines (break-over pushes, display grace). */
  advance(ms: number): void;
  connect(name: string, options?: { userId?: string }): Promise<TestClient>;
  /** Connect with arbitrary handshake auth; resolves with the connect_error message. */
  connectExpectingError(auth: unknown): Promise<string>;
  close(): Promise<void>;
}

export async function startHarness(
  options: { rateLimits?: RateLimitConfig } = {},
): Promise<Harness> {
  const clock = new ManualClock(START);
  const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: '0' });
  const server = createStudySyncServer({
    env,
    clock,
    logger: createLogger('silent'),
    rateLimits: options.rateLimits ?? NO_LIMITS,
  });
  const address = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
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

  return {
    server,
    clock,
    url,
    advance(ms) {
      clock.advance(ms);
      server.scheduler.runDue();
    },
    async connect(name, opts = {}) {
      const userId = opts.userId ?? randomUUID();
      const socket = open({ userId, name });
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
    async close() {
      await Promise.all(clients.map((c) => c.disconnect()));
      await server.close();
    },
  };
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
