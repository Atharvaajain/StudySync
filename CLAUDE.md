# CLAUDE.md — StudySync

Guidance for Claude (and any engineer) working in this repository. Read this first, every session.

## Project status

**Phase 0 — Planning.** Design documents exist; **no application code yet**.
Do **not** scaffold or implement anything until the product owner explicitly approves the
design (and, later, each phase). The complete product specification is pending; when it
arrives, reconcile every doc against it (ARCHITECTURE.md §3 lists the open questions Q1–Q20).

## What StudySync is

A real-time collaborative study app: users study in **reusable rooms**, each with **their own
independent timer**, share a **real-time task list** per room, and get **daily totals (in
their timezone)**, **streaks** and **analytics**.

## Non-negotiable product rules

These are requirements, not suggestions. **Never remove, relax, merge or "simplify" them.**
If something seems to conflict with a rule, stop and ask the product owner.

1. Every user has an **independent timer**.
2. **Never implement a shared timer** — no room timer, no "start together", no group
   countdown, no timer fields on `rooms`, no event that changes another user's timer.
3. **Break time never counts as study time** — study time = Σ `study_segments` only.
4. Breaks are restricted to **5, 10, 15 and 30 minutes** — nothing else, no extensions.
5. **No automatic resume** — only a user command can (re)enter `STUDYING`. Break end →
   `AWAITING_RESUME`; grace expiry → `PAUSED`; reconnect/restart never resumes.
6. **One active session per user** (DB partial unique index + `409 SESSION_ALREADY_ACTIVE`).
7. **Rooms are reusable** — persist when empty; membership and tasks persist.
8. **Room tasks synchronize in real time.**
9. **Disconnect grace is 2 minutes** (retroactive pause at the disconnect instant if exceeded).
10. **Idle timeout is 30 minutes** (idle clock suspended during breaks; warning at 25).
11. **Streak requires 25 minutes (1,500,000 ms) of actual study per local day.**
12. **All timestamps are stored in UTC** (`timestamptz`, DB/session/process TZ = UTC, ISO `Z`).
13. **Daily totals use the user's timezone** (split segments at local midnights, DST-safe).

The canonical values live in `packages/shared/src/constants.ts` (once scaffolded) — never
hard-code them elsewhere, never make them env-configurable.

## Document map

| Doc | Read when |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Always. Requirements analysis, open questions, timer state machine (§9), risks (§13–14), folder structure (§15). |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | Touching schema, queries, migrations. |
| [API_DESIGN.md](./API_DESIGN.md) | Adding/changing endpoints or socket events. |
| [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) | Deciding what to build next; phase exit criteria. |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) | Writing tests; Definition of Done (§11). |

**Docs are part of the change:** if code diverges from a doc, update the doc in the same commit.

## Stack

React + TypeScript + Vite, Tailwind CSS, Recharts · Node.js + Express + TypeScript ·
PostgreSQL + Prisma · Socket.IO · JWT + bcrypt · Zod. Supporting libraries proposed in
ARCHITECTURE §5.2 (pending approval). npm-workspaces monorepo: `apps/web`, `apps/server`,
`packages/shared`, `e2e`.

## Architecture rules (enforced in review)

- **Server-authoritative time.** Clients never send timestamps or durations. Use the injected
  `Clock`; never call `Date.now()`/`new Date()` in domain code.
- **Pure timer machine** (`packages/shared/src/timer`): `transition(state, event) → {state, effects}`.
  No I/O. Every state × event pair is covered by the exhaustive table test.
- **Deadlines are data.** Break end / grace / idle are persisted; `reconcile()` applies due
  transitions *stamped at their deadline*, before every command and read. Timers are only an
  optimization.
- **Single write path:** mutations via REST; Socket.IO for push, presence, activity.
- **Emit after commit** only (EventCollector). Every pushed entity carries a `version`.
- **Validate every boundary** with shared Zod schemas (`.strict()`): HTTP, socket payloads, env, forms.
- **Authorization in services**, scoped queries; unauthorized resource → `404`.
- **DB constraints are the last line of defense** — partial unique indexes, CHECK, EXCLUDE
  (hand-written SQL in migrations; never let a generated migration drop them).
- Timezone math only in `packages/shared/src/time` (Luxon). Durations are integer **ms**.
- No `$queryRawUnsafe`, no `dangerouslySetInnerHTML`, no tokens in `localStorage`.

## Conventions

- TypeScript `strict` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). No `any`
  without a justifying comment.
- Server modules: `*.routes.ts → *.controller.ts → *.service.ts → *.repository.ts`.
- DB: `snake_case` tables/columns via `@map`; named constraints/indexes.
- API: `/api/v1`, error envelope `{ error: { code, message, details?, requestId } }`, UTC ISO
  instants, `YYYY-MM-DD` local dates, `*Ms` durations.
- Socket events: `domain:action` (e.g. `session:state`, `task:created`), ack `{ ok, data | error }`.
- Commits: imperative, scoped (`feat(sessions): …`, `test(accounting): …`, `docs: …`).

## Cloud development environment

The product owner develops **only** in the Claude Code cloud container — never ask them to
install tools locally.

- Available: Node 22, npm 10, PostgreSQL 16 (cluster `16/main`, **stopped by default** —
  start with `scripts/dev-db.sh` once it exists, or `sudo pg_ctlcluster 16 main start`),
  Chromium + Playwright pre-installed (**do not run `playwright install`**). Docker daemon is
  not running.
- The container is **ephemeral**: commit and push work frequently; the DB is disposable
  (`npm run db:reset`).
- Show progress via test results and Playwright screenshots/recordings until a hosted preview
  exists (DEVELOPMENT_ROADMAP §5).

## Commands

*Not available yet — defined in Phase 1.* Planned root scripts: `dev`, `build`, `lint`,
`typecheck`, `test`, `test:integration`, `test:e2e`, `db:migrate`, `db:reset`, `db:seed`.

## Workflow

1. Confirm the current phase and that it is approved (DEVELOPMENT_ROADMAP.md).
2. Re-read the relevant rules and design sections before changing timer, accounting,
   presence, or auth code.
3. Write tests with the code (TESTING_STRATEGY §11 Definition of Done).
4. Run lint, typecheck, and the affected test suites before committing.
5. Commit to the designated branch and push; never push to `main` directly.
6. End each phase with a summary + demo and **wait for approval**.
