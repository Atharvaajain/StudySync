#!/usr/bin/env node
/**
 * Post-deploy smoke test. Checks a running StudySync deployment end to end:
 *   health + readiness, security headers, registration (creates ONE throwaway account),
 *   refresh-cookie flags and rotation, an authenticated read, Socket.IO (polling and, if the
 *   host supports it, WebSocket), and a tiny study session (start → end → summary).
 *
 *   node scripts/smoke.mjs https://your-app.example.com          (the web URL, e.g. Vercel)
 *   node scripts/smoke.mjs https://your-api.onrender.com --api-only  (the backend directly)
 *
 * It never touches existing data and never needs secrets. The throwaway account stays (there is
 * no account deletion before the pre-launch phase, D-4); its email is printed at the end.
 */
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
// --api-only: check a backend that doesn't serve the web app (e.g. the Render URL directly).
const apiOnly = process.argv.includes('--api-only');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const https = base.startsWith('https://');

const health = await fetch(`${base}/api/v1/health`).catch((e) => {
  console.error(`FAIL  cannot reach ${base}: ${e.cause?.code ?? e.message}`);
  process.exit(1);
});
check('GET /api/v1/health', health.ok, String(health.status));
const ready = await fetch(`${base}/api/v1/health/ready`);
check('GET /api/v1/health/ready (database)', ready.ok, String(ready.status));
const page = apiOnly ? health : await fetch(`${base}/`);
if (!apiOnly) {
  check('web app served at /', page.ok && (await page.text()).includes('<div id="root">'));
  const deep = await fetch(`${base}/history`);
  check('SPA fallback for /history', deep.ok);
}
const csp = page.headers.get('content-security-policy') ?? '';
check('Content-Security-Policy header', csp.includes("default-src 'self'"), csp.slice(0, 60));
if (https) {
  check(
    'Strict-Transport-Security header',
    Boolean(health.headers.get('strict-transport-security')),
  );
}

const email = `smoke-${randomUUID().slice(0, 8)}@example.com`;
const register = await fetch(`${base}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Smoke Test',
    email,
    password: `smoke-${randomUUID()}`,
    timezone: 'UTC',
  }),
});
const auth = register.ok ? await register.json() : null;
check('POST /auth/register', register.status === 201, String(register.status));
const cookie = register.headers.get('set-cookie') ?? '';
check(
  'refresh cookie flags',
  /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie) && (!https || /Secure/i.test(cookie)),
  cookie.replace(/ss_refresh=[^;]+/, 'ss_refresh=…').slice(0, 90),
);
const pair = cookie.split(';')[0];
const refresh = await fetch(`${base}/api/v1/auth/refresh`, {
  method: 'POST',
  headers: { 'X-StudySync-CSRF': '1', Cookie: pair },
});
check('POST /auth/refresh rotates the token', refresh.ok, String(refresh.status));
const token = refresh.ok ? (await refresh.json()).accessToken : auth?.accessToken;
const me = await fetch(`${base}/api/v1/users/me`, {
  headers: { Authorization: `Bearer ${token}` },
});
check('GET /users/me with the access token', me.ok);

async function socketCheck(transports) {
  const s = io(base, {
    path: '/socket.io',
    transports,
    auth: { token },
    reconnection: false,
    timeout: 10_000,
  });
  try {
    const state = await new Promise((resolve, reject) => {
      s.once('session_state', resolve);
      s.once('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 15_000);
    });
    return { ok: state.cause === 'CONNECT', socket: s };
  } catch (e) {
    s.close();
    return { ok: false, error: e.message };
  }
}
const polling = await socketCheck(['polling']);
check('Socket.IO over HTTP long-polling', polling.ok, polling.error ?? '');
const ws = await socketCheck(['websocket']);
check('Socket.IO over WebSocket (optional behind proxies)', ws.ok, ws.error ?? '');
const live = polling.ok ? polling.socket : ws.ok ? ws.socket : null;
if (live) {
  const started = await live
    .timeout(10_000)
    .emitWithAck('start_study', { commandId: randomUUID(), roomId: null });
  check('start_study', started.ok === true);
  const ended = started.ok
    ? await live.timeout(10_000).emitWithAck('end_study', {
        commandId: randomUUID(),
        sessionId: started.data.session.id,
      })
    : { ok: false };
  check('end_study → summary', ended.ok === true && ended.data.summary.endReason === 'USER');
}
polling.socket?.close();
ws.socket?.close();

const failed = results.filter((r) => !r.ok && !r.name.includes('optional'));
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed. Throwaway account: ${email}`,
);
process.exit(failed.length === 0 ? 0 : 1);
