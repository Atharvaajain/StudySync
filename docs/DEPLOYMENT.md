# StudySync — Deployment Guide (Neon + Render + Vercel)

> **Status: prepared, not yet deployed.** Every step below was rehearsed locally against a
> production-mode build (`NODE_ENV=production`, bundled server, built web app, PostgreSQL 16):
> `npm run smoke` passed 13/13 checks, HSTS and CSP headers were present, proxy-aware rate
> limits worked, and a real browser stayed signed in across a reload. Nothing has been deployed
> to Neon, Render or Vercel from this repository, so treat hosting-specific details as
> **unverified** until the first deployment passes the smoke test in §6.
>
> **Release blockers (decision D-4):** password reset and account deletion are scheduled for the
> pre-launch phase and are **not implemented**. Do not open StudySync to the public until they
> exist (or you explicitly accept launching without them).

## 1. What runs where

```
Browser ──HTTPS──► Render web service (one Node process)
                     ├─ REST API      /api/v1/*
                     ├─ Socket.IO     /socket.io/*   (WebSocket, or HTTP long-polling)
                     ├─ deadline sweeper + liveness lease (every 5 s)
                     └─ the built web app (optional: Option A)
                        │
                        └──TLS──► Neon PostgreSQL 16 (all state; timezone UTC)
```

The approved architecture requires the web app and the API on **one origin**
(DEVELOPMENT_ROADMAP 5.6): the refresh cookie is `SameSite=Strict` on `/api/v1/auth`, and the
CSP only allows `connect-src 'self'`. Two topologies keep that property:

| | Option A — Render only (recommended) | Option B — Vercel web + Render API |
|---|---|---|
| Web app served by | Render (`STATIC_DIR=apps/web/dist`) | Vercel (static build) |
| API + Socket.IO | Render | Render, reached through Vercel **rewrites** (same origin for the browser) |
| Realtime transport | WebSocket | HTTP long-polling (Vercel rewrites can't carry WebSockets; verified that polling works) |
| `TRUST_PROXY` | `1` | `2` (Vercel + Render proxies — confirm in §6) |
| Moving parts | 2 (Render, Neon) | 3 (Vercel, Render, Neon) |

Run **one** Render instance. Presence, rate limits and the liveness lease live in the process;
scaling out needs the Socket.IO Redis adapter and sticky sessions (ARCHITECTURE §22) first.

## 2. Neon (database)

1. Create a project (PostgreSQL 16) and a database, e.g. `studysync`.
2. In the SQL editor, pin the database timezone (all timestamps are UTC, R12):
   ```sql
   ALTER DATABASE studysync SET timezone TO 'UTC';
   ```
   (The app is also verified to give identical results on a non-UTC session — see the test
   report — but UTC is the documented setting.)
3. Copy the **direct** (non-pooled) connection string and add `sslmode=require` and a small pool:
   `postgresql://USER:PASSWORD@ENDPOINT.REGION.aws.neon.tech/studysync?sslmode=require&connection_limit=10`
   The direct endpoint avoids PgBouncer caveats (prepared statements, `prisma migrate`). One
   Render instance needs about 10 connections.
4. The first migration creates the `btree_gist` extension (used by the no-overlap constraints).
   Neon supports it; if your role may not create extensions, `migrate deploy` fails loudly —
   create it once as the owner: `CREATE EXTENSION IF NOT EXISTS btree_gist;`.
5. Recommended: enable Neon's point-in-time restore / branching for backups.
6. Optional least privilege: run migrations with the owner role, and give the app a role with
   only `SELECT, INSERT, UPDATE, DELETE` on the tables and `USAGE` on the sequences.

## 3. Render (API + Socket.IO, and the web app in Option A)

Use the Blueprint in [`render.yaml`](../render.yaml) or create a **Web Service** by hand:

| Setting | Value |
|---|---|
| Runtime / Node | Node, `NODE_VERSION=22` |
| Build command | `npm ci --include=dev && npm run build` (dev dependencies hold the Prisma CLI and Vite) |
| Pre-deploy command | `npm run db:deploy -w @studysync/server` (applies committed migrations; never resets) |
| Start command | `node apps/server/dist/index.js` |
| Health check path | `/api/v1/health/ready` (checks the database) |
| Instances | 1 |

If your plan has no pre-deploy command, use this start command instead:
`npm run db:deploy -w @studysync/server && node apps/server/dist/index.js`.

Environment variables (template: [`deploy/production.env.example`](../deploy/production.env.example)):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` (Render provides `PORT`) |
| `DATABASE_URL` | the Neon string from §2 |
| `JWT_ACCESS_SECRET` | 32+ random characters (`generateValue` in the Blueprint) |
| `COOKIE_SECURE` | `true` (default) |
| `BCRYPT_COST` | `12` (default; production refuses < 12) |
| `TRUST_PROXY` | `1` (Option A) or `2` (Option B) |
| `STATIC_DIR` | `apps/web/dist` (Option A) or empty (Option B) |
| `LOG_LEVEL` | `info` |

The server **refuses to start** in production if the cookie isn't Secure, the bcrypt cost is
below 12, the JWT secret looks like an example value, any test-only switch is set, or a
`apps/server/.env` file exists (Prisma would load it silently). Never deploy a `.env` file:
production settings come only from the host's environment.

Graceful shutdown: on a deploy, Render sends SIGTERM. Shutdown never starts anyone's 2-minute
grace; clients reconnect to the new instance, and the liveness lease covers the gap (§13.9).

## 4. Vercel (Option B only)

1. New Project → import the repository → **Root Directory `apps/web`** (keep "include files
   outside the root directory" on; npm workspaces install from the repository root).
2. Framework preset: Vite. Build command `npm run build`, output directory `dist`.
3. Copy [`deploy/vercel.example.json`](../deploy/vercel.example.json) to `apps/web/vercel.json`
   and replace `YOUR-RENDER-SERVICE.onrender.com` with your Render host. It:
   - rewrites `/api/*` and `/socket.io/*` to Render, so the browser sees one origin (the
     refresh cookie and `connect-src 'self'` keep working);
   - falls back to `index.html` for client routes;
   - sets the security headers that Render would otherwise send (CSP, nosniff, referrer).
4. On Render set `TRUST_PROXY=2` and leave `STATIC_DIR` empty.

## 5. Scheduled jobs (recommended)

- **Nightly invariant audit** (DATABASE_DESIGN §8) — Render Cron Job with the same build, the
  `DATABASE_URL` variable and the command `npm run db:audit`. It exits non-zero if any invariant
  is broken (any row returned is a bug).
- Nothing else needs a scheduler: auto-saves are applied by the server's own sweeper, and a
  restart applies overdue deadlines stamped at the deadline (verified by the restart tests).

## 6. Verify a deployment

```bash
npm run smoke -- https://YOUR-DOMAIN
```

It checks health and database readiness, the SPA fallback, security headers (HSTS on https),
registration, refresh-cookie flags and rotation, an authenticated read, Socket.IO over
long-polling (required) and WebSocket (optional behind Vercel), and a study session start → end.
It creates **one throwaway account** (printed at the end).

Then, by hand: register in two browsers, create a room, join it by code, take a break, and
check that the other browser sees "On Break mm:ss" within a second.

**Rollback:** redeploy the previous Render deploy. Migrations are additive in this release
(one migration, `20261101042742_init`); never run `prisma migrate reset` against production.

## 7. Known limits of this release

- Password reset and account deletion are not implemented (D-4, release blockers).
- Single instance only (see §1). In-memory rate limits reset on restart.
- No retention job yet for `session_events` / `refresh_tokens` growth (DATABASE_DESIGN §12).
- Email verification does not exist; any address can register.
