/**
 * INT-AUTH, INT-USERS, SEC-3 (JWT), SEC-4 (refresh rotation + reuse), SEC-5 (CSRF + cookie
 * flags), SEC-7 (validation) — REST against the real server and database.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELAXED_HTTP_RATE_LIMITS } from '../../src/http/middleware';
import { TEST_JWT_SECRET, testDb } from '../helpers/db';
import { startHarness, type Harness } from '../helpers/harness';
import { api, bearer, csrf, refreshCookie, register, setCookieHeader } from '../helpers/http';

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ accessTokenTtlSec: 900 });
});
afterEach(async () => {
  await h.close();
});

describe('INT-AUTH register / login', () => {
  it('registers with a timezone and returns a user, an access token and a refresh cookie', async () => {
    const res = await api(h).post('/api/v1/auth/register').send({
      name: '  Atharva  ',
      email: '  Atharva@Example.COM ',
      password: 'correct horse battery',
      timezone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      name: 'Atharva',
      email: 'atharva@example.com',
      timezone: 'Asia/Kolkata',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    expect(res.body.accessTokenExpiresAt).toBe('2026-11-01T10:15:00.000Z'); // 15 min
    // SEC-5: cookie flags
    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/^ss_refresh=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    // Only the SHA-256 hash of the refresh token is stored.
    const raw = refreshCookie(res)!.split('=')[1]!;
    const stored = await testDb().refreshToken.findMany({ where: { userId: res.body.user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.tokenHash).not.toBe(raw);
  });

  it('rejects duplicate emails (case-insensitive), invalid timezones and weak input', async () => {
    await h.close();
    h = await startHarness({ accessTokenTtlSec: 900, httpRateLimits: RELAXED_HTTP_RATE_LIMITS });
    await register(h, { email: 'dup@example.com' });
    const post = (body: object) => api(h).post('/api/v1/auth/register').send(body);
    const valid = {
      name: 'B',
      email: 'other@example.com',
      password: 'correct horse battery',
      timezone: 'UTC',
    };
    expect((await post({ ...valid, email: 'DUP@example.com' })).body.error.code).toBe(
      'EMAIL_TAKEN',
    );
    const tz = await post({ ...valid, timezone: 'Mars/Olympus' });
    expect([tz.status, tz.body.error.code]).toEqual([400, 'INVALID_TIMEZONE']);
    for (const bad of [
      { ...valid, password: 'short' },
      { ...valid, password: 'é'.repeat(37) }, // 74 bytes > bcrypt's 72
      { ...valid, email: 'not-an-email' },
      { ...valid, name: '   ' },
      { ...valid, isAdmin: true }, // SEC-7: unknown keys
    ]) {
      const res = await post(bad);
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
  });

  it('logs in with the right password only; failures are uniform', async () => {
    await register(h, { email: 'me@example.com', password: 'correct horse battery' });
    const ok = await api(h)
      .post('/api/v1/auth/login')
      .send({ email: 'ME@example.com', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe('me@example.com');
    expect(refreshCookie(ok)).not.toBeNull();

    const wrong = await api(h)
      .post('/api/v1/auth/login')
      .send({ email: 'me@example.com', password: 'wrong password!' });
    const unknown = await api(h)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong password!' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }
  });

  it('SEC-6: registrations are limited per IP (5/hour)', async () => {
    for (let i = 0; i < 5; i++) await register(h);
    const res = await api(h).post('/api/v1/auth/register').send({});
    expect([res.status, res.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('SEC-6: login attempts are rate limited per IP + email', async () => {
    const attempt = () =>
      api(h)
        .post('/api/v1/auth/login')
        .send({ email: 'x@example.com', password: 'nope nope nope' });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('SEC-4 refresh rotation and reuse detection / SEC-5 CSRF', () => {
  it('rotates the refresh token on every use', async () => {
    const { cookie } = await register(h);
    const r1 = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', cookie);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toEqual(expect.any(String));
    const next = refreshCookie(r1)!;
    expect(next).not.toBe(cookie);
    const r2 = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', next);
    expect(r2.status).toBe(200);
  });

  it('reusing a rotated token revokes the whole family', async () => {
    const { cookie } = await register(h);
    const rotated = refreshCookie(
      await api(h)
        .post('/api/v1/auth/refresh')
        .set(...csrf)
        .set('Cookie', cookie),
    )!;
    const reuse = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', cookie);
    expect([reuse.status, reuse.body.error.code]).toEqual([401, 'REFRESH_REUSED']);
    // The legitimate (latest) token is now revoked too.
    const after = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', rotated);
    expect([after.status, after.body.error.code]).toEqual([401, 'REFRESH_REUSED']);
  });

  it('requires the CSRF header; rejects missing, unknown and expired tokens', async () => {
    const { cookie } = await register(h);
    const noCsrf = await api(h).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect([noCsrf.status, noCsrf.body.error.code]).toEqual([403, 'CSRF_REQUIRED']);
    const noCookie = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf);
    expect([noCookie.status, noCookie.body.error.code]).toEqual([401, 'REFRESH_INVALID']);
    const bogus = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', 'ss_refresh=bogus');
    expect(bogus.body.error.code).toBe('REFRESH_INVALID');

    h.clock.advance(30 * 24 * 60 * 60_000); // 30 days
    const expired = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', cookie);
    expect([expired.status, expired.body.error.code]).toEqual([401, 'REFRESH_INVALID']);
  });

  it('logout revokes the family and clears the cookie', async () => {
    const { cookie } = await register(h);
    expect((await api(h).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(403);
    const out = await api(h)
      .post('/api/v1/auth/logout')
      .set(...csrf)
      .set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect(setCookieHeader(out)).toMatch(/^ss_refresh=;.*Expires=Thu, 01 Jan 1970/);
    const again = await api(h)
      .post('/api/v1/auth/refresh')
      .set(...csrf)
      .set('Cookie', cookie);
    expect(again.status).toBe(401);
  });
});

describe('SEC-3 access tokens (REST)', () => {
  it('accepts a valid bearer token and rejects every forged, expired or foreign token', async () => {
    const { auth } = await register(h);
    const me = (token?: string) => {
      const req = api(h).get('/api/v1/users/me');
      return token === undefined ? req : req.set(...bearer(token));
    };
    expect((await me(auth.accessToken)).status).toBe(200);

    const sub = auth.user.id;
    const now = Math.floor(h.clock.now() / 1000);
    const claims = { sub, iss: 'studysync', aud: 'studysync-web', iat: now, exp: now + 600 };
    const forged = [
      jwt.sign(claims, 'another-secret-another-secret-another-secret'),
      jwt.sign({ ...claims, iss: 'evil' }, TEST_JWT_SECRET),
      jwt.sign({ ...claims, aud: 'other-app' }, TEST_JWT_SECRET),
      jwt.sign({ ...claims, sub: 'not-a-uuid' }, TEST_JWT_SECRET),
      jwt.sign(claims, TEST_JWT_SECRET, { algorithm: 'HS512' }),
      // alg: none
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`,
      // tampered sub on a validly signed token
      (() => {
        const [head, , sig] = auth.accessToken.split('.');
        const body = Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString(
          'base64url',
        );
        return `${head}.${body}.${sig}`;
      })(),
    ];
    for (const token of forged) {
      const res = await me(token);
      expect([res.status, res.body.error.code]).toEqual([401, 'UNAUTHENTICATED']);
    }
    expect((await me()).body.error.code).toBe('UNAUTHENTICATED');

    h.clock.advance(15 * 60_000);
    const expired = await me(auth.accessToken);
    expect([expired.status, expired.body.error.code]).toEqual([401, 'TOKEN_EXPIRED']);
  });
});

describe('INT-USERS profile and timezone', () => {
  it('reads and edits the name and timezone; validates input', async () => {
    const { auth } = await register(h, { timezone: 'Asia/Kolkata' });
    const patch = (body: object) =>
      api(h)
        .patch('/api/v1/users/me')
        .set(...bearer(auth.accessToken))
        .send(body);

    const updated = await patch({ name: ' Atharva J ', timezone: 'America/New_York' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Atharva J', timezone: 'America/New_York' });
    const me = await api(h)
      .get('/api/v1/users/me')
      .set(...bearer(auth.accessToken));
    expect(me.body).toMatchObject({ name: 'Atharva J', timezone: 'America/New_York' });

    expect((await patch({ timezone: 'Europe/Atlantis' })).body.error.code).toBe('INVALID_TIMEZONE');
    for (const bad of [{}, { email: 'x@example.com' }, { name: '' }, { timezone: 5 }]) {
      const res = await patch(bad);
      expect([res.status, res.body.error.code], JSON.stringify(bad)).toEqual([
        400,
        'VALIDATION_ERROR',
      ]);
    }
  });

  it('does not expose any endpoint outside the Phase 1 scope (D-2, D-4)', async () => {
    const { auth } = await register(h);
    for (const [method, path] of [
      ['delete', '/api/v1/users/me'],
      ['post', '/api/v1/auth/password-reset'],
      ['post', '/api/v1/rooms'],
      ['post', '/api/v1/rooms/join'],
    ] as const) {
      const res = await api(h)
        [method](path)
        .set(...bearer(auth.accessToken))
        .send({});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});
