/**
 * INT-ROOMS (TESTING_STRATEGY §5): create, codes, join by code, My Rooms, member reads,
 * D-2 (membership permanent), D-3 (50 members), CT-10 (last free slot), CT-11 (code collisions),
 * SEC-1/SEC-2 room reads for non-members, SEC-6 join rate limit.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, type MyRoomDto, type RoomDto } from '@studysync/shared';
import { audit, createUser, testDb } from '../helpers/db';
import { MIN, startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

async function user(name = 'U'): Promise<{ id: string; token: string }> {
  const u = await createUser(testDb(), { name });
  return { id: u.id, token: h.tokenFor(u.id) };
}
const createRoom = async (token: string, name: string): Promise<RoomDto> => {
  const res = await api(h)
    .post('/api/v1/rooms')
    .set(...bearer(token))
    .send({ name });
  if (res.status !== 201) throw new Error(`${res.status} ${res.text}`);
  return res.body as RoomDto;
};
const join = (token: string, code: string) =>
  api(h)
    .post('/api/v1/rooms/join')
    .set(...bearer(token))
    .send({ code });

describe('INT-ROOMS create and join', () => {
  it('creates a room with a valid unique code; the creator is a member', async () => {
    const a = await user('Atharva');
    const room = await createRoom(a.token, '  DSA Night Study  ');
    expect(room).toMatchObject({
      name: 'DSA Night Study',
      createdBy: { id: a.id, name: 'Atharva' },
      isCreator: true,
      memberCount: 1,
    });
    expect(room.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`));
    expect(room.code).not.toMatch(/[O0I1]/);
    for (const bad of [{ name: '' }, { name: 'x'.repeat(61) }, { name: 'ok', code: 'AAAAAA' }]) {
      const res = await api(h)
        .post('/api/v1/rooms')
        .set(...bearer(a.token))
        .send(bad);
      expect(res.status).toBe(400);
    }
  });

  it('joins by code: case-insensitive, idempotent, uniform INVALID_CODE', async () => {
    const a = await user('A');
    const b = await user('B');
    const room = await createRoom(a.token, 'Room');
    const joined = await join(b.token, `  ${room.code.toLowerCase()} `);
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ id: room.id, isCreator: false, memberCount: 2 });
    expect((await join(b.token, room.code)).body.memberCount).toBe(2); // idempotent
    for (const bad of ['ZZZZZZ', 'O0I1AB', 'abc', '', 'DSA7K2X']) {
      const res = await join(b.token, bad);
      expect([res.status, res.body.error.code, res.body.error.message]).toEqual([
        404,
        'INVALID_CODE',
        'That room code is not valid.',
      ]);
    }
  });

  it('D-3 / CT-10: at most 50 members; 10 parallel joins for the last slot → exactly one', async () => {
    const owner = await user('Owner');
    const room = await createRoom(owner.token, 'Full house');
    const db = testDb();
    for (let i = 0; i < 48; i++) {
      const u = await createUser(db, { name: `M${i}` });
      await db.roomMember.create({ data: { roomId: room.id, userId: u.id } });
    }
    const racers = await Promise.all(Array.from({ length: 10 }, (_, i) => user(`R${i}`)));
    const results = await Promise.all(racers.map((r) => join(r.token, room.code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.code === 'ROOM_FULL')).toHaveLength(9);
    expect(await db.roomMember.count({ where: { roomId: room.id } })).toBe(50);
  });

  it('SESSION_IN_OTHER_ROOM: a session in room A blocks creating or joining another room', async () => {
    const a = await h.connect('Atharva', { member: false });
    const token = h.tokenFor(a.userId);
    const roomA = await createRoom(token, 'A');
    const owner = await user('Owner');
    const roomB = await createRoom(owner.token, 'B');
    await a.join(roomA.id);
    const s = await a.start(roomA.id);
    const res = await join(token, roomB.code);
    expect([res.status, res.body.error.code]).toEqual([409, 'SESSION_IN_OTHER_ROOM']);
    expect(res.body.error.details).toMatchObject({ roomName: 'A', session: { id: s.id } });
    expect(await testDb().roomMember.count({ where: { roomId: roomB.id } })).toBe(1); // unchanged
    const create = await api(h)
      .post('/api/v1/rooms')
      .set(...bearer(token))
      .send({ name: 'C' });
    expect(create.body.error.code).toBe('SESSION_IN_OTHER_ROOM');
    await a.end(s.id);
    expect((await join(token, roomB.code)).status).toBe(200); // End Study first, then it works
  });

  it('CT-11: forced code collisions during parallel creation still give unique codes', async () => {
    await h.close();
    const codes = ['AAAAAA', 'AAAAAA', 'AAAAAA', 'BBBBBB', 'AAAAAA', 'CCCCCC', 'DDDDDD', 'EEEEEE'];
    let i = 0;
    h = await startHarness({ newRoomCode: () => codes[i++ % codes.length]! });
    const a = await user();
    const rooms = await Promise.all([1, 2, 3, 4].map((n) => createRoom(a.token, `Room ${n}`)));
    expect(new Set(rooms.map((r) => r.code)).size).toBe(4);
  });
});

describe('INT-ROOMS reads, My Rooms, membership', () => {
  it('My Rooms: most recently visited first; membership is permanent (D-2)', async () => {
    const a = await h.connect('Atharva', { member: false });
    const token = h.tokenFor(a.userId);
    const r1 = await createRoom(token, 'First');
    h.advance(MIN);
    const r2 = await createRoom(token, 'Second');
    h.advance(MIN);
    await a.join(r1.id); // visiting r1 makes it the most recent
    const list = (
      await api(h)
        .get('/api/v1/rooms')
        .set(...bearer(token))
    ).body.items as MyRoomDto[];
    expect(list.map((r) => r.name)).toEqual(['First', 'Second']);
    expect(list[0]!.lastVisitedAt).toBe('2026-11-01T10:02:00.000Z');
    // Leaving ends presence only; the room stays in My Rooms (reusable, R7).
    a.ok(await a.call('leave_room', { roomId: r1.id }));
    const after = (
      await api(h)
        .get('/api/v1/rooms')
        .set(...bearer(token))
    ).body.items as MyRoomDto[];
    expect(after.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(await testDb().roomMember.count({ where: { userId: a.userId } })).toBe(2);
  });

  it('SEC-2: non-members get 404 for every room read; members see all members', async () => {
    const a = await h.connect('Atharva', { member: false });
    const b = await user('Bilal');
    const room = await createRoom(h.tokenFor(a.userId), 'Private');
    await a.join(room.id);
    for (const path of ['', '/members', '/tasks', '/today']) {
      const res = await api(h)
        .get(`/api/v1/rooms/${room.id}${path}`)
        .set(...bearer(b.token));
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(
      (
        await api(h)
          .get(`/api/v1/rooms/${randomUUID()}`)
          .set(...bearer(b.token))
      ).status,
    ).toBe(404);
    expect(
      (
        await api(h)
          .get('/api/v1/rooms/nope')
          .set(...bearer(b.token))
      ).status,
    ).toBe(404);
    await join(b.token, room.code);
    const members = await api(h)
      .get(`/api/v1/rooms/${room.id}/members`)
      .set(...bearer(b.token));
    expect(
      members.body.members.map((m: { user: { name: string }; status: string }) => [
        m.user.name,
        m.status,
      ]),
    ).toEqual([
      ['Atharva', 'IDLE'],
      ['Bilal', 'OFFLINE'], // a member who isn't present (I-18)
    ]);
  });

  it('SEC-6: joins are rate limited per user; 20 rooms per user per day', async () => {
    const a = await user();
    for (let i = 0; i < 10; i++) expect((await join(a.token, 'ZZZZZZ')).status).toBe(404);
    const limited = await join(a.token, 'ZZZZZZ');
    expect([limited.status, limited.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    for (let i = 0; i < 20; i++) await createRoom(a.token, `R${i}`);
    const res = await api(h)
      .post('/api/v1/rooms')
      .set(...bearer(a.token))
      .send({ name: 'one more' });
    expect(res.body.error.code).toBe('RATE_LIMITED');
    h.advance(24 * 60 * MIN);
    const fresh = h.tokenFor(a.id); // the old access token expired during the jump
    const later = await api(h)
      .post('/api/v1/rooms')
      .set(...bearer(fresh))
      .send({ name: 'ok' });
    expect(later.status).toBe(201);
  });
});
