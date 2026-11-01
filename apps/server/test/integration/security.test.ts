/**
 * SEC-1 (authorization matrix, API_DESIGN §11) for every REST endpoint, table-driven:
 * anonymous → 401; a valid user who is not a member → 404 on every room resource; another
 * user's session → 404; cookie endpoints need the CSRF header. SEC-7 body limits.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomDto } from '@studysync/shared';
import { audit, createUser, testDb } from '../helpers/db';
import { startHarness, type Harness } from '../helpers/harness';
import { api, bearer } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
  expect(await audit()).toEqual([]);
});

type Method = 'get' | 'post' | 'patch';
const call = (method: Method, path: string, token?: string, body: object = {}) => {
  const req = api(h)[method](`/api/v1${path}`);
  if (token) req.set(...bearer(token));
  return method === 'get' ? req : req.send(body);
};

describe('SEC-1 authorization matrix (REST)', () => {
  it('every authenticated endpoint rejects anonymous and forged callers with 401', async () => {
    const rid = randomUUID();
    const endpoints: [Method, string][] = [
      ['get', '/users/me'],
      ['patch', '/users/me'],
      ['get', '/tasks'],
      ['get', '/sessions/current'],
      ['get', '/sessions'],
      ['get', `/sessions/${rid}/summary`],
      ['post', `/sessions/${rid}/summary-seen`],
      ['get', '/stats/today'],
      ['get', '/stats/daily?from=2026-11-01&to=2026-11-01'],
      ['get', '/stats/periods?granularity=week&from=2026-11-01&to=2026-11-01'],
      ['get', '/stats/heatmap?from=2026-11-01&to=2026-11-01'],
      ['get', '/stats/streak'],
      ['get', '/rooms'],
      ['post', '/rooms'],
      ['post', '/rooms/join'],
      ['get', `/rooms/${rid}`],
      ['get', `/rooms/${rid}/members`],
      ['get', `/rooms/${rid}/tasks`],
      ['get', `/rooms/${rid}/today`],
    ];
    for (const [method, path] of endpoints) {
      for (const token of [undefined, 'garbage', `${h.tokenFor(randomUUID())}x`]) {
        const res = await call(method, path, token);
        expect([`${method} ${path}`, res.status]).toEqual([`${method} ${path}`, 401]);
      }
    }
  });

  it('room resources: members only (404 for everyone else, no existence leak)', async () => {
    const owner = (await createUser(testDb(), { name: 'Owner' })).id;
    const outsider = (await createUser(testDb(), { name: 'Outsider' })).id;
    const room = (await call('post', '/rooms', h.tokenFor(owner), { name: 'Private' }))
      .body as RoomDto;
    const missing = randomUUID();
    for (const id of [room.id, missing]) {
      for (const path of ['', '/members', '/tasks', '/today']) {
        const res = await call('get', `/rooms/${id}${path}`, h.tokenFor(outsider));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND'); // identical for existing and missing rooms
      }
    }
    for (const path of ['', '/members', '/tasks', '/today']) {
      expect((await call('get', `/rooms/${room.id}${path}`, h.tokenFor(owner))).status).toBe(200);
    }
  });

  it('sessions are owner-only; cookie endpoints need CSRF; bodies over 100 KB are refused', async () => {
    const a = await h.connect('Atharva', { member: false });
    const s = await a.start(null);
    await a.end(s.id);
    const other = (await createUser(testDb())).id;
    for (const [method, path] of [
      ['get', `/sessions/${s.id}/summary`],
      ['post', `/sessions/${s.id}/summary-seen`],
    ] as const) {
      expect((await call(method, path, h.tokenFor(other))).status).toBe(404);
    }
    expect((await api(h).post('/api/v1/auth/refresh')).status).toBe(403);
    expect((await api(h).post('/api/v1/auth/logout')).status).toBe(403);
    const huge = await call('patch', '/users/me', h.tokenFor(a.userId), {
      name: 'x'.repeat(200_000),
    });
    expect(huge.status).toBe(413);
  });
});
