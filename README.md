# StudySync

A study platform where students track tasks, run their own study timer with controlled
breaks, and build streaks — solo, or together in shared rooms where everyone sees each other's
status but studies at their own pace.

> _Your study time is always yours. Rooms give presence and shared tasks — never a shared timer._

**Status: Phase 0 — real-time technical prototype** (branch `feature/phase-0-realtime-prototype`).
Two browsers study independently in one hardcoded room (**DSA Night Study**, code `DSA7K2`) with
live status synchronization. See the [Phase 0 test report](./docs/phase-0/TEST_REPORT.md).

---

## Quick start (cloud development container)

Everything runs inside the Claude Code cloud container; nothing needs to be installed locally.
Node 22 and npm 10 are already present.

```bash
npm install
```

```bash
npm run dev
```

This starts the server on `http://127.0.0.1:4000` and the web app on `http://127.0.0.1:5173`.
Vite proxies `/api` and `/socket.io` to the server, so the browser sees one origin.

**Trying two users:** each browser tab keeps its own prototype identity (in `sessionStorage`), so
open the app in two tabs or two browsers, enter two different names, and you are two members of
the same room. The dev container is not reachable from your own computer, so the Phase 0 demo is
provided as screenshots and videos (see [Demo](#demo)).

### Production-style build

```bash
npm run build
```

```bash
cd apps/server && STATIC_DIR=../web/dist node dist/index.js
```

The server then serves the built web app and Socket.IO on one origin (port 4000).
`NODE_ENV=production` is deliberately **refused** in Phase 0, because the prototype has no
authentication.

---

## Scripts

| Command                      | What it does                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                | Server (tsx watch) + web (Vite) with hot reload                      |
| `npm run build`              | Build the web app (Vite) and bundle the server (esbuild)             |
| `npm start`                  | Run the bundled server (`apps/server/dist`)                          |
| `npm run typecheck`          | Strict TypeScript in every workspace                                 |
| `npm run lint`               | ESLint, incl. "no wall clock in domain code" and "no raw HTML" rules |
| `npm run format` / `…:check` | Prettier                                                             |
| `npm test`                   | All Vitest suites: shared timer core, server unit, server realtime   |
| `npm run test:unit`          | Timer core + server unit tests only                                  |
| `npm run test:integration`   | Realtime acceptance tests (real server + real Socket.IO clients)     |
| `npm run test:e2e`           | Builds the web app, then runs the two-browser Playwright suite       |
| `npm run test:all`           | typecheck + lint + all tests + E2E                                   |

Useful variables: `FC_RUNS=50000 npm test` (more property-test cases),
`CAPTURE_SCREENSHOTS=1 npm run test:e2e` (regenerate the report screenshots).

> In the cloud container the Chromium build for Playwright is pre-installed. **Do not run
> `playwright install`** there (CI runners do install it).

---

## Demo

| Moment                                                    | Screenshot (two browsers side by side)                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Both studying, independent timers                         | [01-both-studying-independently.png](./docs/phase-0/screenshots/01-both-studying-independently.png) |
| Alice on break; Bob keeps studying and sees her countdown | [02-alice-on-break-bob-studying.png](./docs/phase-0/screenshots/02-alice-on-break-bob-studying.png) |
| Break over — no automatic resume                          | [03-break-over-no-auto-resume.png](./docs/phase-0/screenshots/03-break-over-no-auto-resume.png)     |
| Alice ended (summary shown); Bob unaffected               | [04-alice-ended-bob-unaffected.png](./docs/phase-0/screenshots/04-alice-ended-bob-unaffected.png)   |

Per-browser videos are written by `npm run test:e2e` to `e2e/.artifacts/videos/` (not committed).

---

## Project structure

```
packages/shared   Contract shared by client and server: constants (break lengths, grace, …),
                  strict Zod schemas, typed Socket.IO events, and the PURE timer state machine
apps/server       Express 5 + Socket.IO: session engine around the pure machine, an in-memory
                  store that enforces the database's integrity rules, presence, deadline scheduler
apps/web          React 19 + Vite + Tailwind 4: renders server timestamps, never decides time
e2e               Playwright: two real browsers in one room
docs/phase-0      Phase 0 test report and screenshots
```

Design documents (the permanent source of truth): [CLAUDE.md](./CLAUDE.md) ·
[ARCHITECTURE.md](./ARCHITECTURE.md) · [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) ·
[API_DESIGN.md](./API_DESIGN.md) · [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) ·
[TESTING_STRATEGY.md](./TESTING_STRATEGY.md)

---

## How Phase 0 enforces the rules

| Rule                                        | Where                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Independent timer per user, no shared timer | Sessions are per user; rooms hold no timer state; room events only describe each member's own status |
| Breaks: 5, 10, 15, 30 min only              | Zod literal schema, the pure machine, a store integrity rule, and a UI with exactly four buttons     |
| Break time never counts                     | Taking a break closes the study segment at the same instant; study time = Σ segments                 |
| No automatic resume                         | Only the user's `resume_study` re-enters studying, and only after the countdown has ended            |
| Server is the source of truth               | Strict schemas reject any client timestamp or duration; every instant comes from the server clock    |
| Refresh-proof timer                         | `session_state` on every connect; the UI shows `closed segments + (now − segment start)`             |
| One active session per user                 | Per-user command queue + the store rule `study_sessions_one_active_per_user`                         |

## Configuration

See [`.env.example`](./.env.example): `NODE_ENV` (`development` | `test`), `PORT`, `HOST`,
`LOG_LEVEL`, `STATIC_DIR`, `ENABLE_TEST_CLOCK` (test only).

## Not in Phase 0

Authentication, database persistence, personal tasks, real room creation and join by code,
analytics, streaks, notifications, and disconnect/idle auto-save. These arrive in later phases
(see the roadmap).
