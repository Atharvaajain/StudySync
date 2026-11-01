# StudySync — Deployment Guide (Vercel + Render + Neon)

> **Status: prepared and rehearsed locally — not deployed.** The production build, the
> API-only backend and a Vercel-like proxy were rehearsed in the development container (see
> [the readiness report](./PRODUCTION_READINESS.md)). No Vercel, Render or Neon account has been
> used yet, so hosting-specific settings are **unverified until the first deployment passes §7**.
>
> **Release blockers (decision D-4):** password reset and account deletion are not implemented.
> Do not open StudySync to the public until they exist, or until you explicitly accept that.

## 1. Topology

```
Browser ──HTTPS──► Vercel (static web app)
                     ├─ /*            → apps/web/dist (SPA fallback to index.html)
                     ├─ /api/*        ──rewrite──► Render ─┐
                     └─ /socket.io/*  ──rewrite──► Render ─┤  one Node process:
                                                           │  REST + Socket.IO + sweeper
                                                           └──TLS──► Neon PostgreSQL 16
```

- **One origin for the browser.** Vercel rewrites keep `/api` and `/socket.io` on the Vercel
  domain, as the approved architecture requires (DEVELOPMENT_ROADMAP 5.6): the refresh cookie
  stays `SameSite=Strict`, and the CSP keeps `connect-src 'self'`. No CORS is needed.
- **Realtime runs on HTTP long-polling.** Vercel rewrites don't carry WebSockets; the client
  starts on long-polling and stays there (rehearsed: live statuses reached a second browser in
  under 100 ms).
- **One Render instance.** Presence, rate limits and the liveness lease are per process.
  Scaling out needs the Socket.IO Redis adapter and sticky sessions first (ARCHITECTURE §22).

Alternative (fewer moving parts): let Render serve the web app too — build with
`npm run build`, set `STATIC_DIR=apps/web/dist` and `TRUST_PROXY=1`, and skip Vercel. WebSockets
then work directly.

## 2. Environment variables (backend, Render)

Template: [`deploy/production.env.example`](../deploy/production.env.example). Set them in the
Render dashboard — never commit them, and never deploy a `.env` file.

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `DATABASE_URL` | yes | Neon **direct** connection string with `sslmode=require` (§3) |
| `JWT_ACCESS_SECRET` | yes | 32+ random characters (the Blueprint generates one) |
| `HOST` | yes | `0.0.0.0` (Render provides `PORT`) |
| `TRUST_PROXY` | yes | `2` (Vercel rewrite + Render load balancer); `1` without Vercel |
| `COOKIE_SECURE` | default | `true` — production refuses `false` |
| `BCRYPT_COST` | default | `12` — production refuses less |
| `STATIC_DIR` | no | empty with Vercel; `apps/web/dist` without Vercel |
| `LOG_LEVEL` | no | `info` |
| `NODE_VERSION` | yes | `22` |

The server **refuses to start** in production if the cookie isn't Secure, the bcrypt cost is
below 12, the JWT secret looks like an example, any test-only switch is set
(`ENABLE_TEST_CLOCK`, `RELAX_RATE_LIMITS`, token-lifetime overrides), or an
`apps/server/.env` file exists (Prisma would load it silently).

The web app needs **no** environment variables: it calls `/api` and `/socket.io` on its own
origin.

## 3. Neon (database)

1. Create a project (PostgreSQL 16) and a database, e.g. `studysync`.
2. In the SQL editor: `ALTER DATABASE studysync SET timezone TO 'UTC';` (R12). The app is also
   tested to give identical results on a non-UTC session, but UTC is the documented setting.
3. Copy the **direct** (non-pooled) connection string, then append the SSL mode and a pool size:
   `postgresql://USER:PASSWORD@ENDPOINT.REGION.aws.neon.tech/studysync?sslmode=require&connection_limit=10`
   Direct connections avoid PgBouncer caveats for migrations and prepared statements.
4. Recommended: point-in-time restore / branching (backups); a least-privilege app role
   (`SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE` on sequences), with migrations run by
   the owner role.

## 4. Database migrations

Migrations are committed in `apps/server/prisma/migrations/` (today: one migration,
`20261101042742_init`, which also creates the hand-written constraints of DATABASE_DESIGN §5
and the `btree_gist` extension).

| Situation | Command |
|---|---|
| Every deployment (Render pre-deploy) | `npm run db:deploy -w @studysync/server` → `prisma migrate deploy` (applies pending migrations, never drops data) |
| By hand, from your machine | `DATABASE_URL='<neon direct url>' npm run db:deploy -w @studysync/server` |
| Check the data afterwards | `DATABASE_URL='<neon direct url>' npm run db:audit` (any reported row is a bug) |
| Creating a new migration (development only) | DATABASE_DESIGN §10: `prisma migrate dev --create-only`, review the SQL, never let it drop the hand-written constraints |

**Never** run `prisma migrate reset`, `prisma migrate dev` or `prisma db push` against Neon:
they can drop data or the hand-written constraints. If `btree_gist` can't be created by your
role, run `CREATE EXTENSION IF NOT EXISTS btree_gist;` once as the owner, then deploy again.

## 5. Render (backend)

Use the Blueprint in [`render.yaml`](../render.yaml), or create a **Web Service** by hand:

| Setting | Value |
|---|---|
| Build command | `npm ci --include=dev && npm run build -w @studysync/server` |
| Pre-deploy command | `npm run db:deploy -w @studysync/server` |
| Start command | `node apps/server/dist/index.js` |
| Health check path | `/api/v1/health/ready` (includes the database) |
| Instances | 1 |

`--include=dev` is required: the Prisma CLI (client generation, migrations) and esbuild are
dev dependencies. If your plan has no pre-deploy command, use the start command
`npm run db:deploy -w @studysync/server && node apps/server/dist/index.js`.

Deploys send SIGTERM; shutdown never starts anyone's 2-minute grace. Clients reconnect to the
new instance, and the liveness lease covers the gap (ARCHITECTURE §13.9).

Nightly audit (recommended): a Render **Cron Job** with the same build, `DATABASE_URL`, and the
command `npm run db:audit` (non-zero exit = invariant violation).

## 6. Vercel (frontend)

1. New Project → import the repository. **Root Directory: the repository root** (npm
   workspaces build from there; the web app depends on `packages/shared`).
2. Copy [`deploy/vercel.example.json`](../deploy/vercel.example.json) to **`vercel.json` at the
   repository root** and replace both `YOUR-RENDER-SERVICE.onrender.com` with your Render host.
   It sets:
   - install `npm ci`, build `npm run build -w @studysync/web`, output `apps/web/dist`;
   - rewrites for `/api/*` and `/socket.io/*` to Render, and the SPA fallback;
   - the security headers for the web app (CSP, `nosniff`, referrer, frame options).
3. No environment variables are needed on Vercel.
4. On Render, confirm `TRUST_PROXY=2` and an empty `STATIC_DIR`.

## 7. Verify a deployment

```bash
npm run smoke -- https://YOUR-VERCEL-DOMAIN
npm run smoke -- https://YOUR-RENDER-SERVICE.onrender.com --api-only
```

The first checks the whole path through Vercel: web app and SPA fallback, CSP and HSTS,
registration, refresh-cookie flags and rotation, an authenticated read, Socket.IO over
long-polling (required; WebSocket is reported as optional), and a study session start → end.
Each run creates **one throwaway account** (printed).

Then by hand, with two browsers (or one normal + one private window): register both, create a
room, join it by code, start studying, take a break, and confirm the other browser shows
"On Break mm:ss" within a second. Finally, check rate limits per client: six wrong logins from
one device are refused (429) while another network can still log in — if everyone is refused,
`TRUST_PROXY` is too low.

**Rollback:** redeploy the previous Render deploy and the previous Vercel deployment. This
release has one additive migration; never reset the production database.

## 8. Known limits

- Password reset and account deletion are not implemented (D-4) — release blockers.
- Single instance; in-memory rate limits reset on restart.
- No retention job for `session_events` / `refresh_tokens` yet (DATABASE_DESIGN §12).
- No email verification.
