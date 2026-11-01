/**
 * Several users in several rooms at once (RT-10, RT-12, SEC-11): broadcasts never cross rooms,
 * every timer stays independent, and the HTTP long-polling transport (used when a proxy can't
 * carry WebSockets, e.g. a Vercel rewrite) behaves exactly like WebSockets.
 */
import { randomUUID } from 'node:crypto';
import { io as connectClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomDto, SessionStatePayload } from '@studysync/shared';
import { audit } from '../helpers/db';
import { MIN, startHarness, type Harness, type TestClient } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

async function room(owner: TestClient, name: string): Promise<RoomDto> {
  return (
    await api(h)
      .post('/api/v1/rooms')
      .set(...bearer(h.tokenFor(owner.userId)))
      .send({ name })
  ).body as RoomDto;
}
async function joinByCode(c: TestClient, code: string): Promise<void> {
  await api(h)
    .post('/api/v1/rooms/join')
    .set(...bearer(h.tokenFor(c.userId)))
    .send({ code });
}

describe('two rooms, four users', () => {
  it('statuses and room tasks stay inside their room; timers stay independent', async () => {
    const [a, b, c, d] = await Promise.all(
      ['Atharva', 'Bilal', 'Chen', 'Dana'].map((n) => h.connect(n, { member: false })),
    );
    const r1 = await room(a!, 'Room One');
    const r2 = await room(c!, 'Room Two');
    await joinByCode(b!, r1.code);
    await joinByCode(d!, r2.code);
    await a!.join(r1.id);
    await b!.join(r1.id);
    await c!.join(r2.id);
    await d!.join(r2.id);
    const marks = [a, b, c, d].map((x) => x!.mark());

    const sa = await a!.start(r1.id);
    await c!.start(r2.id);
    h.advance(10 * MIN);
    await a!.takeBreak(sa.id, 5);
    a!.ok(await a!.call('task_add', { id: randomUUID(), roomId: r1.id, title: 'Room 1 task' }));
    c!.ok(await c!.call('task_add', { id: randomUUID(), roomId: r2.id, title: 'Room 2 task' }));
    await Promise.all([a, b, c, d].map((x) => x!.sync()));

    const roomsSeen = (x: TestClient, i: number) =>
      new Set(
        x.received
          .slice(marks[i])
          .filter((e) => ['status_changed', 'member_joined', 'room_task_updated'].includes(e.event))
          .map((e) => (e.payload as { roomId: string }).roomId),
      );
    expect(roomsSeen(b!, 1)).toEqual(new Set([r1.id]));
    expect(roomsSeen(d!, 3)).toEqual(new Set([r2.id]));
    // Nobody receives anybody else's session_state (R1/R2).
    for (const [i, x] of [a, b, c, d].entries()) {
      const own = x!.received
        .slice(marks[i])
        .filter((e) => e.event === 'session_state')
        .map((e) => (e.payload as SessionStatePayload).session?.id ?? null);
      const mine = (await x!.sync()).session?.id ?? null;
      expect(own.every((id) => id === null || id === mine)).toBe(true);
    }
    expect((await c!.sync()).session).toMatchObject({ phase: 'STUDYING', roomId: r2.id });
    expect((await a!.sync()).session).toMatchObject({ phase: 'ON_BREAK', roomId: r1.id });

    // A member of room 1 can't touch room 2's tasks or presence.
    const r2tasks = await api(h)
      .get(`/api/v1/rooms/${r2.id}/tasks`)
      .set(...bearer(h.tokenFor(b!.userId)));
    expect(r2tasks.status).toBe(404);
    const enter = await b!.call('join_room', { roomId: r2.id });
    expect(!enter.ok && enter.error.code).toBe('NOT_FOUND');
  });
});

describe('HTTP long-polling transport', () => {
  it('handshake, commands and pushes work without WebSockets', async () => {
    const a = await h.connect('Atharva', { member: false });
    const socket = connectClient(h.url, {
      path: '/socket.io',
      transports: ['polling'],
      forceNew: true,
      reconnection: false,
      auth: { token: h.tokenFor(a.userId) },
    });
    const first = await new Promise<SessionStatePayload>((resolve, reject) => {
      socket.once('session_state', resolve);
      socket.once('connect_error', reject);
    });
    expect(first.cause).toBe('CONNECT');
    expect(socket.io.engine.transport.name).toBe('polling');
    const pushed = new Promise<SessionStatePayload>((resolve) =>
      socket.on('session_state', (p: SessionStatePayload) => p.cause === 'START' && resolve(p)),
    );
    const ack = (await socket.timeout(5_000).emitWithAck('start_study', {
      commandId: randomUUID(),
      roomId: null,
    })) as { ok: boolean };
    expect(ack.ok).toBe(true);
    expect((await pushed).session?.phase).toBe('STUDYING');
    socket.disconnect();
  });
});
