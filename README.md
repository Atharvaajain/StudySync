# StudySync

A study platform where students track tasks, run their own study timer with controlled
breaks, and build streaks — solo, or together in shared rooms where everyone sees each other's
status but studies at their own pace.

> _Your study time is always yours. Rooms give presence and shared tasks — never a shared timer._

**Status: Phase 2 — rooms and real-time synchronization** (branch `feature/phase-2-rooms`).
On top of Phase 1 (accounts, solo timer, tasks, totals, history, streak): rooms with codes, My
Rooms, live member statuses, shared room tasks, Today in this room, moving a solo session into a
room without resetting it, the 2-minute disconnect grace and the 30-minute idle auto-save — all
restart-safe. Test reports: [Phase 2](./docs/phase-2/TEST_REPORT.md) ·
[Phase 1](./docs/phase-1/TEST_REPORT.md) · [Phase 0](./docs/phase-0/TEST_REPORT.md).

---

## Quick start (cloud development container)

Everything runs inside the Claude Code cloud container; nothing needs to be installed locally.
Node 22, npm 10 and PostgreSQL 16 are already present.

1. Start PostgreSQL and create the `studysync` role and databases (idempotent):

   ```bash
   scripts/dev-db.sh
   ```

2. Install dependencies (this also generates the Prisma client):

   ```bash
   npm install
   ```

3. Create the server's local config and apply the migrations:

   ```bash
   cp .env.example apps/server/.env
   ```

   ```bash
   npm run db:migrate
   ```

4. Optional demo data (three users, two weeks of history; password `studysync-demo`):

   ```bash
   npm run db:seed
   ```

5. Run the app:

   ```bash
   npm run dev
   ```

The server runs on `http://127.0.0.1:4000` and the web app on `http://127.0.0.1:5173`. Vite
proxies `/api` and `/socket.io` to the server, so the browser sees one origin.

**Trying rooms with several users:** sign-in uses an httpOnly cookie, so each user needs a
separate browser profile (or a private window). One user creates a room on the dashboard and
shares its 6-character code (or the `/join/CODE` invite link); the others join with it. Two tabs
of the same profile are the same user — which is how "two tabs can't create two sessions" is
tested. With the seed, the demo users are already members of **DSA Night Study** (`DSA7K2`). The dev container is not reachable
from your own computer, so demos are provided as screenshots and E2E videos.

### Production-style build

```bash
npm run build
```

```bash
cd apps/server && STATIC_DIR=../web/dist node dist/index.js
```

The server then serves the built web app and Socket.IO on one origin (port 4000).
`NODE_ENV=production` is deliberately **refused** until the pre-launch phase (Phase 5).

---

## Scripts

| Command                      | What it does                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`                | Server (tsx watch) + web (Vite) with hot reload                                     |
| `npm run build`              | Build the web app (Vite) and bundle the server (esbuild)                            |
| `npm start`                  | Run the bundled server (`apps/server/dist`)                                         |
| `npm run db:migrate`         | `prisma migrate dev` on the development database                                    |
| `npm run db:reset`           | Drop and re-create the development database (asks Prisma; destroys dev data)        |
| `npm run db:seed`            | Demo users and history (never overwrites existing demo users)                       |
| `npm run typecheck`          | Strict TypeScript in every workspace                                                |
| `npm run lint`               | ESLint, incl. "no wall clock in domain code", "no raw HTML", "no unsafe raw SQL"    |
| `npm run format` / `…:check` | Prettier                                                                            |
| `npm test`                   | All Vitest suites: shared timer core, web unit, server unit, server DB + realtime   |
| `npm run test:unit`          | Timer core, web and server unit tests (no database)                                 |
| `npm run test:integration`   | PostgreSQL integration + realtime suites (`studysync_test`, migrated automatically) |
| `npm run test:e2e`           | Builds the web app, then runs Playwright against the real server + `studysync_e2e`  |
| `npm run test:all`           | typecheck + lint + all tests + E2E                                                  |

Useful variables: `FC_RUNS=50000 npm test` (more property-test cases),
`CAPTURE_SCREENSHOTS=1 npm run test:e2e` (regenerate the report screenshots),
`TEST_DATABASE_URL` / `E2E_DATABASE_URL` (other test databases; their names must end in
`_test` / `_e2e`, a guard against touching real data).

> In the cloud container the Chromium build for Playwright is pre-installed. **Do not run
> `playwright install`** there (CI runners do install it).

---

## What is built

| Area                 | Delivered                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and profile | Register (timezone detected), login, logout, rotating refresh cookie with reuse detection, CSRF header, rate limits; name and timezone in Settings                        |
| Solo timer           | Start · Take Break (5/10/15/30 only) · Break Over · manual Resume · End Study, refresh-proof, with an attached task                                                       |
| Recording and stats  | Server-stamped segments (each with its timezone snapshot), breaks never counted; summary; TODAY Solo/Rooms/Total; per-day totals split at local midnight; history; streak |
| Personal tasks       | Add, edit, complete, delete; live across your tabs                                                                                                                        |
| Rooms                | Create (unique 6-character code), join by code or `/join/CODE` link, My Rooms, leave and rejoin; membership is permanent (D-2); at most 50 members (D-3)                  |
| Room screen          | Every member with 🟢 Studying / 🟡 On Break mm:ss / ⚪ Idle / ⚫ Offline (and "reconnecting"), your own timer, shared room tasks, Today in this room                      |
| Room moves           | "Study with friends" on the solo timer, or joining a room while studying solo, moves the session into the room without resetting it (segment split)                       |
| Auto-save            | Disconnect grace (2 min, solo vs room liveness per ARCHITECTURE §11.3) and idle timeout (30 min in Break Over), stamped at the deadline; "session saved" notice           |
| Restart safety       | Deadlines are data: a sweeper (every 5 s and at boot) with a liveness lease applies them after a crash or restart exactly as if processed on time                         |

**Not built yet** (later phases, per the roadmap): weekly/monthly charts and room history
(Phase 3–4), polish such as notifications (Phase 4), password reset and account deletion
(Phase 5). Never built: shared timers, chat, video, voice, leaderboards.

---

## How the rules are enforced

| Rule                                        | Where                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent timer per user, no shared timer | Sessions are per user; `rooms` has no timer columns (audit H); room events only describe each member's own status                                  |
| Breaks: 5, 10, 15, 30 min only              | Zod literal schema, the pure machine, DB `brk_duration_allowed` / `brk_ends_exact`, and a picker with exactly four buttons                         |
| Break time never counts                     | A break closes the study segment at the same instant (audits A, F); every total is Σ segments only                                                 |
| No automatic resume                         | Only the user's `resume_study` enters studying, only after `ends_at` (`brk_resume_only_after_end`, `evt_no_system_resume`)                         |
| One active session per user                 | Per-user queue + `pg_advisory_xact_lock` + `SELECT … FOR UPDATE` + unique index `study_sessions_one_active_per_user`                               |
| Server controls all timestamps              | Strict schemas reject client instants/durations; every instant comes from the injected server clock; SQL never uses `now()`                        |
| Days in the user's timezone                 | Midnight split in SQL per segment timezone snapshot (DATABASE_DESIGN §6.1), validated on the DST matrix                                            |
| Disconnect grace (2 min)                    | Liveness re-evaluated on every connect / disconnect / join / leave / start / move; auto-save closes the open interval at the loss instant (row 10) |
| Idle timeout (30 min in Break Over)         | Deadline derived from `break_ends_at`; break closed at exactly `ends_at + 30 min` (`brk_idle_exact`)                                               |
| Survives restarts                           | Sweeper + liveness lease (`pg_try_advisory_xact_lock`, `last_seen_at`); every operation reconciles due deadlines first                             |
| Streak from history                         | Gaps-and-islands query over daily totals (§6.2); nothing is stored                                                                                 |
| Refresh-proof timer                         | `session_state` on every connect; the UI renders `closed segments + (now − segment start)` against a corrected server clock                        |
| Integrity                                   | Hand-written constraints from DATABASE_DESIGN §5 in the migration; every DB test ends with the §8 audit queries returning no rows                  |

---

## Project structure

```
packages/shared   Contract shared by client and server: constants, strict Zod schemas, DTOs,
                  typed Socket.IO events, timezone helpers and the PURE timer state machine
apps/server       Express 5 + Socket.IO + Prisma 6 (PostgreSQL 16)
  prisma/           schema (DATABASE_DESIGN §4), migration with the §5 constraints, dev seed
  src/modules/      auth · users · sessions (engine, repository, sweeper) · tasks · stats · rooms · presence
  src/realtime/     Socket.IO gateway (JWT handshake, rate limits, per-user queue, emit after commit)
apps/web          React 19 + Vite + Tailwind 4 + React Router: renders server timestamps only
e2e               Playwright: Phase 0 two-browser suite, Phase 1 flows, Phase 2 three-user rooms
docs/phase-0|1|2  Test reports and screenshots
scripts/dev-db.sh Starts PostgreSQL and creates the dev / test / e2e databases (UTC)
```

Design documents (the permanent source of truth): [CLAUDE.md](./CLAUDE.md) ·
[ARCHITECTURE.md](./ARCHITECTURE.md) · [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) ·
[API_DESIGN.md](./API_DESIGN.md) · [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) ·
[TESTING_STRATEGY.md](./TESTING_STRATEGY.md)

## Configuration

See [`.env.example`](./.env.example) (copy it to `apps/server/.env`): `DATABASE_URL`,
`JWT_ACCESS_SECRET` (≥ 32 characters), `COOKIE_SECURE`, `PORT`, `HOST`, `LOG_LEVEL`,
`STATIC_DIR`, and test-only switches (`ENABLE_TEST_CLOCK`, `RELAX_RATE_LIMITS`, token
lifetimes, low bcrypt cost) that the server refuses outside `NODE_ENV=test`.
