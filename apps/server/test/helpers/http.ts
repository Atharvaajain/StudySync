/** REST helpers for integration tests (supertest against the in-process server). */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CSRF_HEADER, REFRESH_COOKIE, type AuthResponse } from '@studysync/shared';
import type { Harness } from './harness';

export const api = (h: Harness) => request(h.url);

export const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
export const csrf: [string, string] = [CSRF_HEADER, '1'];

/** The `ss_refresh=…` pair from a response's Set-Cookie header (or null). */
export function refreshCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const hit = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!hit) return null;
  const pair = hit.split(';')[0]!;
  return pair === `${REFRESH_COOKIE}=` ? null : pair;
}

export function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  return cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`)) ?? '';
}

export async function register(
  h: Harness,
  overrides: Partial<{ name: string; email: string; password: string; timezone: string }> = {},
): Promise<{ auth: AuthResponse; cookie: string }> {
  const res = await api(h)
    .post('/api/v1/auth/register')
    .send({
      name: 'Atharva',
      email: `${randomUUID()}@example.com`,
      password: 'correct horse battery',
      timezone: 'Asia/Kolkata',
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
  return { auth: res.body as AuthResponse, cookie: refreshCookie(res)! };
}
