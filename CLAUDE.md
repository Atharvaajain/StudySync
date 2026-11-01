# CLAUDE.md — StudySync

Read this first, every session. It is the standing brief for Claude (and any engineer) working here.

## Project status

**Architecture v1.1 APPROVED (with clarifications, ARCHITECTURE §5).** Implemented so far:
Phase 0 (spike), Phase 1 (solo core), Phase 2 (rooms) and the MVP finalization
(`feature/phase-3-finalization`: charts, heatmap, break notification, UX pass, security review,
production config, deployment preparation). **Not deployed; not launch-ready** until password
reset and account deletion (D-4) exist. Awaiting the product owner's approval — do not start
new work until it is given. Reports: `docs/phase-<n>/TEST_REPORT.md`; deployment:
`docs/DEPLOYMENT.md`.

## Engineering governance (standing rules from the product owner — apply for the whole project)

The six documents (CLAUDE.md, ARCHITECTURE.md, DATABASE_DESIGN.md, API_DESIGN.md,
DEVELOPMENT_ROADMAP.md, TESTING_STRATEGY.md) are the **permanent source of truth** for StudySync.

1. **Never delete or overwrite** any of the six documents without the product owner's explicit
   approval.
2. **Read this file and the relevant architecture documents before implementing any major
   feature.**
3. **Never silently change** the approved architecture, database schema, API contracts or
   product requirements.
4. If a technical change is necessary, **first explain the reason, the impact and the
   alternatives**, and wait for a decision before making it.
5. When an approved architectural decision changes, **update the relevant documentation**
   (and record the decision in ARCHITECTURE §5).
6. **Keep documentation synchronized with the implementation.** Code and docs change in the
   same commit.
7. **Every development phase is tested against TESTING_STRATEGY.md** before it is reported as
   done.
8. **Do not introduce features outside the approved scope** (DEVELOPMENT_ROADMAP §11) without
   the product owner's permission.
9. **Preserve the independent timer principle** throughout: never a shared timer.
10. **Never sacrifice data integrity or security** for implementation convenience.

## What StudySync is

Students study solo or together in rooms. **Each user runs their own server-verified timer.**
Rooms are always-on spaces joined by a 6-character code. Members see each other's live status
(🟢 studying / 🟡 on break with countdown / ⚪ idle / ⚫ offline) and share a task list, but
**study time is always individual**. Breaks are 5/10/15/30 min and never count. Resume is
manual and only after the countdown ends. Sessions auto-save after a 2-minute disconnect or 30
minutes in Break Over. Days are counted in the user's timezone. A streak day needs ≥ 25
minutes of recorded study.

> **Core rule: your study time is always yours. Rooms give presence and shared tasks — never a shared timer.**

## Non-negotiable product rules

Never remove, relax, merge or "simplify" these. If something seems to conflict with a rule,
stop and ask.

1. Every user has an **independent timer**. **Never implement a shared timer**: no room timer,
   no group start or end, no timer columns on `rooms`, no event that changes another user's timer.
2. States: `STUDYING` → `ON_BREAK` → `BREAK_OVER` → (Resume) → `STUDYING`. End Study from any
   state. Offline is presence, not a timer state.
3. **Breaks: 5, 10, 15 or 30 minutes only** (30 max). Take Break only from `STUDYING`.
4. **Break time never counts as study time.** Study time = Σ `study_segments`, nothing else.
5. **No automatic resume.** Resume only from `BREAK_OVER` (countdown finished), only by the
   user. No early resume.
6. **One ACTIVE session per user, ever** (DB partial unique index). No solo study while in a
   room, never two rooms. A session lives in one room. A solo session moves into a room on
   create or join. Room A → room B requires End Study first.
7. **Disconnect grace = 2 minutes.** Back in time → nothing lost. Otherwise the session ends
   and saves at the disconnect instant. **Liveness differs by session type** (ARCHITECTURE
   §11.3): a **solo** session stays live while the user has any connection (any page, tab or
   device); a **room** session stays live only while that room's screen is open on at least one
   tab or device.
8. **Idle timeout = 30 minutes in `BREAK_OVER`** → the session ends and saves. There is no other
   idle or "still studying?" rule in the MVP (D-1).
9. **Rooms are reusable.** Membership ≠ presence ≠ session (three separate concepts).
   **Membership is permanent in the MVP** (D-2). Max **50 members** per room (D-3).
10. **Room tasks sync in real time.** Only room members can touch them.
11. **Server is the source of truth.** Clients never send timestamps or durations.
12. **All timestamps stored in UTC.** **Daily totals use the user's timezone** (split at local midnights).
    Each segment keeps the timezone snapshot from when it started. Historical totals group by
    that snapshot; "today" uses the current timezone (D-6).
13. **Streak = consecutive local days with ≥ 25 min recorded study, computed from history.**
    Never store a counter.
14. Room codes: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no O/0/I/1), unique.

Canonical values live in `packages/shared/src/constants.ts`: never hard-coded elsewhere,
never env-configurable.

**Not building:** video, voice, chat, file or screen sharing, AI, notes, music, calendar,
friends, public communities, leaderboards. **Not in the MVP:** the empty-chair prompt (D-1);
leaving membership, room rename, room deletion and password change; member removal and
room-code regeneration (future enhancements, D-2). **Pre-launch (Phase 5) only:** password
reset and account deletion (D-4).

## Final product decisions (ARCHITECTURE §5)

| ID | Decision |
|---|---|
| D-0 | Architecture v1.1 approved, including interpretations I-01…I-22 |
| D-1 | No empty-chair prompt in the MVP; idle and disconnect rules unchanged |
| D-2 | Membership permanent; member removal and code regeneration are future enhancements |
| D-3 | 50 members per room |
| D-4 | Password reset and account deletion deferred to pre-launch (Phase 5) |
| D-5 | Rules unchanged during breaks; break screen shows a "keep StudySync open" hint |
| D-6 | Timezone snapshot per segment; historical totals use it |
| D-7 | Solo vs room liveness documented and tested separately |

## Document map

| Doc | Use it for |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Spec coverage (§2), rules → enforcement (§3), interpretations (§4), **product decisions (§5)**, edge cases (§6), membership/presence/session and **solo vs room liveness (§11.3)**, **timer state machine + transition table (§13)**, timezones (§14), security (§17), risks (§18) |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | Schema, hand-written constraints, validated time-split SQL, audit queries |
| [API_DESIGN.md](./API_DESIGN.md) | REST endpoints, socket events (spec names), error codes, authorization matrix |
| [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) | Step-by-step build plan, acceptance criteria per phase |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) | Test layers, IDs, DST matrix, Definition of Done, release checklist |

Code and docs change together. If code diverges from a doc, update the doc in the same commit.

## Architecture rules (enforced in review)

- **Pure timer core** (`packages/shared/src/timer`): `phaseOf()`, `decide()`, `dueAutoSave()`.
  No I/O and no `Date.now()`. The exhaustive phase × event table test must stay complete.
- **Phase is derived**, not stored: STUDYING iff `current_segment_started_at`; otherwise
  ON_BREAK until `break_ends_at`, then BREAK_OVER.
- **Deadlines are data.** Reconcile before every command and read; auto-saves are stamped at
  the deadline instant. Timers and the sweeper are just triggers.
- **Socket.IO for commands** (`start_study`, `take_break`, `resume_study`, `end_study`,
  `set_session_task`, `join_room`, `leave_room`, `task_*`). **REST** for auth, room
  create/join, reads and stats. One shared service layer.
- **Per-user serialization:** an in-process queue + `pg_advisory_xact_lock(user)` + row lock
  for every session mutation, including the sweeper (`pg_try_advisory_xact_lock` + `SKIP LOCKED`).
- **Liveness:** solo session = any socket on any page; room session = present in that room
  (ARCHITECTURE §11.3). Segment-opening commands for a room session must come from a socket
  present in its room.
- **No stored counters.** Totals, streaks and summaries are SQL over segments, with the
  timezone snapshot per segment.
- **Emit after commit.** Every push carries a `version` or is a full snapshot.
- **Validate every boundary** with shared Zod `.strict()` schemas. Authorization lives in
  services; foreign resources → 404.
- **DB constraints are the last line of defense.** Hand-written SQL in migrations; never let
  a generated migration drop it (`INT-SCHEMA` guards this).
- Banned: `$queryRawUnsafe`, `dangerouslySetInnerHTML`, tokens in `localStorage`, SQL `now()`
  in time logic (pass `$now` from the injected `Clock`).

## Conventions

- TypeScript strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Server modules: `*.routes.ts → *.controller.ts → *.service.ts → *.repository.ts`, plus
  `*.socket.ts` handlers.
- DB: `snake_case` via `@map`; named constraints. API: `/api/v1`, UTC ISO instants with `Z`,
  `YYYY-MM-DD` local dates, `…Ms` durations.
- Socket events: **snake_case, exact spec names** (`join_room`, `status_changed`, …), acks
  `{ ok, data | error }`.
- Commits: `feat(sessions): …`, `test(rooms): …`, `docs: …`. Small and frequent.

## Cloud development environment

The product owner works **only** in the Claude Code cloud container. Never ask them to install
tools locally.

- Node 22, npm 10, PostgreSQL 16 (cluster `16/main`, stopped by default; start it with
  `scripts/dev-db.sh` once it exists, or `pg_ctlcluster 16 main start`), Chromium +
  Playwright pre-installed (**never run `playwright install`**). The Docker daemon is not running.
- The container is **ephemeral**: commit and push after every step. The DB is disposable
  (`npm run db:reset`).
- Show progress with test reports and Playwright screenshots or recordings until a hosted
  preview exists.

## Commands

`scripts/dev-db.sh` (start PostgreSQL, create the dev / test / e2e databases) · `npm run dev` ·
`build` · `start` · `lint` · `typecheck` · `format` / `format:check` · `test` (all Vitest
projects) · `test:unit` · `test:integration` (PostgreSQL `studysync_test`) · `test:e2e`
(Playwright, `studysync_e2e`) · `db:migrate` · `db:reset` · `db:seed` · `db:audit` ·
`smoke -- <url>`. Local config:
`cp .env.example apps/server/.env`.

## Workflow

1. Confirm the current phase and step are approved (DEVELOPMENT_ROADMAP.md).
2. Re-read the rules above and ARCHITECTURE §13 before touching timer, presence or accounting code.
3. Write tests with the code (TESTING_STRATEGY §10).
4. Run lint, typecheck and the affected suites before committing.
5. Commit to the designated feature branch and push. Never push to `main` directly.
6. At each phase end: summary + demo + **wait for approval**.
