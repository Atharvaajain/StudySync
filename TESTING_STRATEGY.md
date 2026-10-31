# StudySync — Testing Strategy

> **Status: Draft v0.1 (planning phase).** It defines how every product rule is proven.
> Test IDs referenced from [ARCHITECTURE.md](./ARCHITECTURE.md) (`T-Rn`, `CT-n`, `RT-n`)
> are defined here.

---

## Contents

1. [Goals & principles](#1-goals--principles)
2. [Test pyramid & tooling](#2-test-pyramid--tooling)
3. [Environments](#3-environments)
4. [Determinism: controlling time](#4-determinism-controlling-time)
5. [Test layers](#5-test-layers)
6. [Timezone & DST matrix](#6-timezone--dst-matrix)
7. [Invariants checked after every integration test](#7-invariants-checked-after-every-integration-test)
8. [Test data](#8-test-data)
9. [CI pipeline](#9-ci-pipeline)
10. [Coverage & quality gates](#10-coverage--quality-gates)
11. [Definition of Done](#11-definition-of-done)
12. [Requirements traceability matrix](#12-requirements-traceability-matrix)
13. [Manual exploratory checklist](#13-manual-exploratory-checklist)

---

## 1. Goals & principles

1. **Every product rule (R1–R13) is proven at more than one layer**: a pure unit or property
   test, an integration test against real PostgreSQL, and an end-to-end test where it is
   user-visible (§12).
2. **Real database, real sockets.** Integration and realtime tests run against PostgreSQL 16 and
   a real Socket.IO server. The database is never mocked for logic that depends on
   constraints, locks or transactions.
3. **No waiting on wall-clock time.** Breaks of up to 30 minutes, 2-minute grace and 30-minute
   idle are all tested in milliseconds through an injected `Clock` (§4).
4. **Invariants over examples.** Property-based tests generate thousands of random timer
   histories and check invariants that must hold for *every* history.
5. **No flaky tests.** A flaky test is a bug. It is fixed at the root cause, never retried,
   skipped or quarantined.
6. **Tests ship with code.** No phase is complete without its tests (§11).

---

## 2. Test pyramid & tooling

```
                ▲  E2E (Playwright, 2+ browser contexts)               ~25 scenarios
               ▲▲▲  Realtime (socket.io-client ↔ in-process server)     ~40
             ▲▲▲▲▲▲  Integration (Supertest + PostgreSQL)              ~250
         ▲▲▲▲▲▲▲▲▲▲▲▲  Unit + property (pure machine, time, utils)     ~400 + 10k generated cases
```

| Tool | Use |
|---|---|
| **Vitest** | Unit, integration and realtime tests (all workspaces) |
| **fast-check** | Property-based tests of the timer machine, reconcile and local-day splitting |
| **Supertest** | HTTP integration against the Express app factory (no `listen`) |
| **socket.io-client** | Realtime tests against the in-process Socket.IO server on an ephemeral port |
| **React Testing Library** + **user-event** | Component and hook tests |
| **MSW** | Mock HTTP for frontend tests (never used for server tests) |
| **Playwright** | E2E: multiple browser contexts = multiple users. `page.clock` for browser time. |
| **k6** / custom socket.io-client load script | Performance tests (§5.10) |

---

## 3. Environments

| Environment | Database | Notes |
|---|---|---|
| **Cloud dev container** (primary) | Local PostgreSQL 16 cluster started by `scripts/dev-db.sh` | Chromium + Playwright are pre-installed (`/opt/pw-browsers`). **Do not run `playwright install`.** Docker is not required. |
| **GitHub Actions CI** | `postgres:16` service container | Same scripts and env as the cloud container. |

**Database isolation for parallel tests**

- `globalSetup` creates `studysync_test_template` and runs `prisma migrate deploy` once.
- Each Vitest worker gets its own database, `CREATE DATABASE studysync_test_<VITEST_POOL_ID>
  TEMPLATE studysync_test_template` (fast file copy).
- Between tests, `TRUNCATE` all application tables `RESTART IDENTITY CASCADE`. Tests are
  **not** wrapped in a rolled-back transaction, because concurrency tests need real commits
  and real row locks.
- Test env: `NODE_ENV=test`, `BCRYPT_COST=4`, `TZ=UTC`, `ENABLE_TEST_CLOCK=true` (E2E only).

---

## 4. Determinism: controlling time

| Seam | Production | Tests |
|---|---|---|
| `Clock.now()` | System time | `FakeClock` with `set(instant)` / `advance(ms)` |
| Scheduler timer port | `setTimeout` wrapper | `ManualTimerPort` (`fireDue(now)`), or a disabled scheduler with explicit sweeps |
| Sweeper | 5 s interval | `sweeper.runOnce()` called explicitly |
| Lease tick | 30 s interval | `lease.tick()` called explicitly |
| ID generation | `crypto.randomUUID` | Default real; deterministic generator where snapshots need it |
| Browser time (E2E) | Real | Playwright `page.clock` |
| Server time (E2E) | Real | `POST /__test__/clock` (test builds only) |

Rules:
- **`vi.useFakeTimers()` is not used in tests that touch PostgreSQL or sockets** (it stalls
  real I/O). The injected `Clock` is used instead.
- Assertions on instants compare exact ISO strings, because all instants are server-generated
  and deterministic under `FakeClock`.

---

## 5. Test layers

### 5.1 Pure timer machine (`packages/shared/test/timer`)

**Exhaustive transition table:** every *(state × event)* pair is a row in a table-driven
test, with the expected target state and effects, or the expected rejection.

| States | Events |
|---|---|
| `NONE`, `STUDYING`, `PAUSED`, `ON_BREAK`, `AWAITING_RESUME`, `ENDED` | `START`, `PAUSE`, `RESUME`, `START_BREAK(5/10/15/30)`, `START_BREAK(invalid: 0, 1, 7, 20, 25, 45, 60, -5, 10.5)`, `END`, `CHANGE_ROOM`, `ACTIVITY`, `BREAK_ELAPSED`, `GRACE_EXPIRED`, `IDLE_TIMEOUT`, `DISCONNECTED`, `RECONNECTED`, `LEASE_LOST` |

6 states × 25 events = **150 rows**. A test fails if any pair is missing from the table, so new
events cannot be added without deciding their behavior in every state.

Focused unit tests:

- **Break ≠ study:** `START_BREAK` at *t* yields `CloseSegment{at: t}` **before**
  `OpenBreak{at: t}`. No effect list ever has an open segment and an open break at once.
- **No auto resume:** for every system event and every state, the resulting status is never
  `STUDYING` unless it already was.
- **Grace:** segment closed at `max(segmentStartedAt, disconnectedAt)`. A command while
  disconnected re-anchors grace.
- **Idle:** deadline = `max(lastActivityAt, lastBreakEndedAt) + 30 min`. No idle deadline while
  `ON_BREAK`. The warning is at deadline − 5 min. The segment closes at
  `max(segmentStartedAt, lastActivityAt)`.
- **Reconcile ordering:** multiple overdue deadlines are applied in chronological order, each
  stamped at its own instant, with the tie-break rule `BREAK_ELAPSED < GRACE_EXPIRED < IDLE_TIMEOUT`.
- **Display helpers:** elapsed and break-remaining calculations, including negative clock offsets.

**Property-based tests (fast-check, 10,000 runs locally / 100,000 nightly).** The generator
produces random histories: interleavings of user commands (including invalid ones), time
advances from 0 ms to 3 h, disconnects and reconnects, and activity pings. Each history is
run through `transition` + `reconcile`, and these properties are checked:

| ID | Property |
|---|---|
| P1 | Segments and breaks of a history never overlap one another (R3). |
| P2 | Σ segment ms + Σ break ms ≤ session wall-clock span. |
| P3 | Every entry into `STUDYING` is caused by a USER event (R5). |
| P4 | Every break duration ∈ {5,10,15,30} min, and actual ≤ planned (R4). |
| P5 | **Late-processing equivalence:** reconciling at `t_late` yields the same final state and effects as applying each deadline exactly on time (restart safety). |
| P6 | If there is no activity for ≥ 30 min outside breaks, the session is `ENDED` by `IDLE_TIMEOUT` (R10). |
| P7 | Disconnected time is credited **iff** reconnect happened within 120 s (R9). |
| P8 | `version` strictly increases with every state-visible change. |
| P9 | `ENDED` is terminal; at most one session is "active" in a single-user history (R6). |

### 5.2 Time utilities (`packages/shared/test/time`)

- `splitByLocalDay(start, end, tz)`: conservation (Σ pieces = duration), each piece ≤ 25 h,
  pieces are contiguous, and dates are consecutive. Run with the full matrix in §6 plus
  fast-check over random zones from `Intl.supportedValuesOf('timeZone')` and random intervals
  within ±2 years.
- `localDateOf(instant, tz)`, `isValidTimeZone`, streak computation from a list of qualified
  dates (gaps, today/yesterday boundary, `atRisk`).

### 5.3 Server unit tests (`apps/server/test/unit`)

JWT sign and verify (pinned algorithm), password policy (72-byte limit with multi-byte
characters), refresh-token hashing, error handler mapping, Zod env validation (refuses
`ENABLE_TEST_CLOCK` in production), presence store (multi-socket counting, one room per
user), socket token-bucket limiter, fractional position generation, effect → SQL persistence
mapping, post-commit `EventCollector` (discarded on rollback).

### 5.4 Integration tests: HTTP + PostgreSQL (`apps/server/test/integration`)

| Suite | Covers |
|---|---|
| `INT-SCHEMA` | After migrations, every named constraint and index in DATABASE_DESIGN §5 exists. Direct SQL inserts that violate each constraint are rejected (break duration 20, overlapping segments, second active session, grace ≠ 2 min, daily total > 25 h, SYSTEM `RESUMED` event). |
| `INT-AUTH` | Register, login, refresh rotation, reuse detection revokes the family, logout, logout-all, `token_version`, cookie attributes, CSRF header. |
| `INT-USERS` | Profile, timezone validation and audit row, password change, account deletion cascade and room transfer. |
| `INT-ROOMS` | Create, discover, join by code or public, capacity, leave, owner transfer, roles, kick, archive and restore. Rooms persist when empty and are reusable across many sessions (R7). |
| `INT-TASKS` | CRUD, idempotent create by client id, `ID_CONFLICT`, version conflicts, status set-semantics, moves, delete permissions, `410` after delete, 500-task limit. |
| `INT-SESS` | Every command endpoint × every state (HTTP mirror of §5.1). `409 SESSION_ALREADY_ACTIVE` (R6). Break durations (R4). `INVALID_TRANSITION` returns current state. `commandId` replay. Reconcile on `GET /sessions/active` after `FakeClock.advance`. History and detail. Other users' sessions → `404` (R1). |
| `INT-ACC` | Segment close → daily totals split by local day (§6 matrix). Break ms attributed separately. 25-min threshold sets `qualified_at` exactly once. Streak recompute with late data (midnight-spanning segment). |
| `INT-STATS` | Each stats endpoint: zero-filled series, user-timezone "today", live open-segment inclusion, range caps. |
| `INT-RESILIENCE` | Grace expiry via sweeper, idle timeout via sweeper, lease-lost detection, **restart recovery** (new app instance on the same DB; overdue deadlines reconciled with deadline-stamped times; no auto resume). |

### 5.5 Concurrency tests (`apps/server/test/concurrency`)

Real parallel requests (`Promise.all`) against a real database. Each test runs 20× in CI to
expose races, and then asserts the §7 invariants.

| ID | Scenario | Expected |
|---|---|---|
| CT-1 | 20 parallel `POST /sessions` by one user | Exactly one `201`, 19 × `409 SESSION_ALREADY_ACTIVE`. One active row. |
| CT-2 | Parallel pause + break + end on one session | Serialized. A consistent final state. Versions strictly increase. One open interval at most at any time. |
| CT-3 | Same `commandId` sent 10× in parallel | Applied once. All responses are equal. One event row. |
| CT-4 | `RESUME` at exactly `break_ends_at` | Deterministic: `BREAK_ELAPSED` is applied first (stamped at `endsAt`), then `RESUME`. Break = full duration. |
| CT-5 | Sweeper + scheduler + user command on the same due session | The deadline is applied once. No duplicate events or segments. |
| CT-6 | Two app instances (two containers on one DB) running sweepers | Each due session is processed exactly once (`SKIP LOCKED`). |
| CT-7 | Kill an app instance mid-session, start a new one | Lease-lost → grace anchored at `last_seen_at` → `PAUSED`. Never resumed automatically. |
| CT-8 | Parallel credits to the same `(user, local_date)` | The final `study_ms` equals the exact sum (no lost update). |
| CT-9 | Forced overlapping segment insert (bypassing the service) | Rejected by `seg_no_overlap_per_user`. |
| CT-10 | Two members edit the same task with the same `expectedVersion` | One `200`, one `409 VERSION_CONFLICT` with the current task. |
| CT-11 | 10 parallel moves into the same gap | All succeed with distinct positions. The final order is total and identical for every reader. |
| CT-12 | 10 users join a room with 1 free slot | Exactly one joins. `member_count ≤ max_members`. |

### 5.6 Realtime tests (`apps/server/test/realtime`)

In-process HTTP + Socket.IO server on an ephemeral port, real `socket.io-client`
connections, and `FakeClock`.

| ID | Scenario |
|---|---|
| RT-1 | Handshake: valid token, missing, invalid, expired, revoked (`token_version`), more than 5 sockets → `connect_error` codes. |
| RT-2 | `room:join` authorization: a non-member is rejected; a kicked member's sockets are removed from the channel immediately and receive no further room events. |
| RT-3 | Presence: join and leave broadcasts, snapshot in the ack, one room at a time across the user's tabs [Q7], `room:member_status` on timer change. |
| RT-4 | **Disconnect grace (R9):** closing one of two tabs → no grace. Closing the last tab → `reconnecting`. Reconnect at +119 s → still `STUDYING`, gap credited. No reconnect → at +120 s `PAUSED`, segment closed at the disconnect instant, member removed. A later reconnect stays `PAUSED`. Reconnect racing disconnect (connect handled before disconnect) → no spurious grace. |
| RT-5 | `session:state` reaches **all** of the user's sockets and **no** other user's (R1). |
| RT-6 | Ordering: the REST response and broadcast arrive in either order and the client cache ends at the highest version. A rolled-back transaction emits nothing (emit after commit). |
| RT-7 | Kick or archive while the member is studying: the member leaves the channel, and their own timer keeps running with room context cleared (segment split). |
| RT-8 | Idle: `session:idle_warning` at 25 min. `activity:ping` resets it. Timeout at 30 min → `ENDED` with `cause: IDLE_TIMEOUT`. No idle timeout during a 30-min break. |
| RT-9 | `auth:renew` extends the socket. Expiry without renewal → `auth:expired` + disconnect. Logout-all → `auth:revoked` + disconnect. |
| RT-10 | Task events reach every present member within 1 s, carry versions, and are not delivered to non-present members or other rooms. |
| RT-11 | Socket payload validation (`VALIDATION_ERROR` ack) and per-event rate limits (`RATE_LIMITED`). |
| RT-12 | **No shared timer (R2):** a test sweeps every server→client event type and asserts that none can change another user's session. With A and B in a room, A's commands change only A's `session:state` stream. |

### 5.7 Frontend tests (`apps/web/src/**/*.test.tsx`)

- **Timer components:** `TimerPanel` renders each status. `BreakPicker` renders **exactly**
  5/10/15/30 (R4). When the break countdown reaches 0, the panel shows "Break over" and sends
  **no** request (R5). Resume is enabled in `PAUSED`, `AWAITING_RESUME` and `ON_BREAK`.
- **Hooks:** `useServerClock` offset estimation, `useSessionTimer` with a skewed clock,
  `useActivityTracker` throttling (≤ 1 ping / 60 s), and the `IdleWarningModal` flow.
- **Cache bridge:** stale-version events are dropped. Task create/update/move/delete patches
  are applied. Optimistic task insert is reconciled with the server echo.
- **Auth client:** single-flight refresh on `401 TOKEN_EXPIRED`, one retry, logout on
  `REFRESH_REUSED`.
- **Security:** task titles and room names containing HTML or script are rendered as text.
- **Accessibility:** `jest-axe`-style checks on key pages. Keyboard-only timer control.

### 5.8 End-to-end tests (`e2e/specs`, Playwright)

The server runs with `ENABLE_TEST_CLOCK=true`. Multiple browser contexts act as different
users.

| ID | Scenario | Rules |
|---|---|---|
| E2E-1 | Register (timezone auto-detected) → logout → login → reload keeps the session (refresh cookie) | Auth |
| E2E-2 | Alice and Bob in the same room. Alice starts; Bob's timer stays idle. Bob starts 5 min later; the two elapsed times differ by 5 min. Each sees the other's status. | R1, R2 |
| E2E-3 | 10-min break: countdown → server clock +10 min → "Break over" → still not studying after +30 s → Resume → studying | R3, R4, R5 |
| E2E-4 | The break picker shows only 5/10/15/30. A crafted API call with 20 → `400`. | R4 |
| E2E-5 | Task sync: Alice creates, edits, completes and reorders; Bob sees each change within 1 s. A concurrent edit shows the conflict UI. | R8 |
| E2E-6 | Offline for 90 s (`context.setOffline` + test clock) → still studying after reconnect. Offline > 2 min → paused, credited only up to the disconnect, and Resume is required. | R9, R5 |
| E2E-7 | Idle 25 min → warning modal → "Still studying" → continues. Idle 30 min → session ended. | R10 |
| E2E-8 | Second tab tries to start a session → shown the existing session instead | R6 |
| E2E-9 | Study 24 min → not qualified. Study 1 more min → streak 1, today marked in the chart. | R11 |
| E2E-10 | User in `Asia/Kolkata` studies 23:30–00:30 local → daily chart shows 30 + 30 min | R12, R13 |
| E2E-11 | Leave the room, rejoin the next day: room, tasks and membership persist, and a new session starts in it | R7 |
| E2E-12 | Kicked mid-session → removed from the room view, own timer still running | R1, C15 |

### 5.9 Security tests

| ID | Test |
|---|---|
| SEC-1 | **Authorization matrix** (API_DESIGN §15) executed table-driven: every endpoint × {anonymous, non-member, member, moderator, owner, other user} → expected status. |
| SEC-2 | IDOR: another user's session, another room's task, a private room by id → `404`. |
| SEC-3 | JWT: `alg: none`, wrong secret, expired, wrong `iss`/`aud`, tampered `sub`. |
| SEC-4 | Refresh rotation, reuse detection, `token_version` revocation on password change. |
| SEC-5 | CSRF header required on cookie endpoints. Cookie flags asserted. |
| SEC-6 | Rate limits return `429` with `Retry-After`. |
| SEC-7 | Validation: unknown keys, oversize body (`413`), malformed UUIDs, non-UTC instants, invalid timezones. |
| SEC-8 | Stored XSS payloads in task titles and room names render inert (component + E2E). |
| SEC-9 | Response scan: no DTO from any endpoint contains `passwordHash`, `tokenHash` or the refresh token. |
| SEC-10 | The app refuses to boot with `NODE_ENV=production` + `ENABLE_TEST_CLOCK=true`. The test-clock route returns `404` when disabled. |
| SEC-11 | Socket: payload validation, event rate limits, max sockets per user, no room events after a kick. |
| SEC-12 | Log redaction: authorization, cookie and password fields are never logged. |
| SEC-13 | CI: `npm audit --audit-level=high`, secret scanning, and lint rule banning `$queryRawUnsafe` / `dangerouslySetInnerHTML`. |

### 5.10 Performance tests (Phase 9, manual dispatch in CI)

| ID | Target (initial, to be confirmed) |
|---|---|
| PERF-1 | Timer command p95 < 150 ms at 200 req/s |
| PERF-2 | 1,000 sockets in 20 rooms × 50 members. Task broadcast fan-out p95 < 500 ms. |
| PERF-3 | Sweeper lag (processing time − deadline) p95 < 2 s with 10,000 active sessions |
| PERF-4 | Stats endpoints p95 < 200 ms with 1 year of data per user |

---

## 6. Timezone & DST matrix

Used by `splitByLocalDay` unit tests, `INT-ACC`, streak tests and E2E-10. Expected values are
computed in tests via Luxon from local wall times, never hard-coded UTC offsets.

| Zone | Why | Cases |
|---|---|---|
| `UTC` | Baseline | Segment across 00:00Z |
| `America/New_York` | DST both ways | Spring-forward day 2026-03-08 (23 h day). Fall-back day 2026-11-01 (25 h day; a 01:30–01:30 "repeat"). Segment across midnight on each. |
| `Europe/London` | DST at 01:00 | 2026-03-29, 2026-10-25 |
| `Asia/Kolkata` | +05:30, no DST | 23:30–00:30 local split (ARCHITECTURE §9.11-F) |
| `Asia/Kathmandu` | +05:45 | Quarter-hour offset |
| `Australia/Lord_Howe` | 30-minute DST shift | Both transition days |
| `Pacific/Kiritimati` (+14) and `Pacific/Pago_Pago` (−11) | Same UTC instant on dates two calendar days apart | A daily total and "today" for two users at the same instant |
| `America/Santiago` | DST transition at local midnight (midnight may not exist) | `startOf('day')` correctness on transition dates (resolved from tzdata in the test) |
| Timezone change mid-day | Q13 | Segment A in `Asia/Kolkata`, user switches to `America/New_York`, segment B attributed with the new snapshot. Streak consecutive-day logic still holds. |

---

## 7. Invariants checked after every integration test

An `afterEach` hook in integration, concurrency and realtime suites runs the audit queries from
[DATABASE_DESIGN.md §8](./DATABASE_DESIGN.md#8-invariants--audit-queries). Any returned row
fails the test.

| Invariant | Rule |
|---|---|
| A — no segment overlaps a break | R3 |
| B — session totals = Σ closed segments / breaks | R3 |
| C — Σ daily totals = Σ closed segments (time is conserved by attribution) | R13 |
| D — `STUDYING` ⇔ exactly one open segment | R3, R6 |
| E — `ON_BREAK` ⇔ exactly one open break | R4 |
| F — every transition into `STUDYING` has actor `USER` | R5 |
| G — at most one non-ended session per user (also a DB constraint) | R6 |

---

## 8. Test data

- **Factories** (`test/helpers/factories.ts`): `createUser({ timezone })`,
  `createRoom({ owner, visibility })`, `addMember()`, `createTask()`,
  `startSession()`, `authHeader(user)`, `connectSocket(user)`. Each factory goes through
  services, never raw inserts, so data always satisfies the invariants. The exception is
  `INT-SCHEMA` and CT-9, which deliberately bypass services.
- **Scenario builder** for timer histories:
  `timeline(user).start('09:00').breakFor(10, '09:50').resume('10:07').end('10:30')` drives
  `FakeClock` and the API. It is used for accounting and stats tests.
- **Seed** (DATABASE_DESIGN §10) is for manual QA and demos, never relied upon by automated tests.

---

## 9. CI pipeline

`.github/workflows/ci.yml` runs on every push and pull request:

```
install (npm ci, cache) ─┬─ lint + format check + typecheck (all workspaces)
                         ├─ unit: shared (incl. property tests, 10k runs) · server unit · web
                         ├─ integration + concurrency + realtime (postgres:16 service)
                         └─ build web + server ─► e2e (Playwright, Chromium, test clock)
nightly: property tests 100k runs · concurrency suite ×100 · npm audit · invariant audit on seed DB
manual:  performance suite (k6 + socket load script)
```

All jobs must pass before merge. Failures upload artifacts: Playwright traces and videos,
server logs and the test DB dump.

---

## 10. Coverage & quality gates

| Scope | Gate |
|---|---|
| `packages/shared/src/timer/**`, `packages/shared/src/time/**` | **100 %** lines and branches |
| `apps/server/src/modules/sessions/**`, `accounting/**` | ≥ 95 % lines, ≥ 90 % branches |
| `apps/server` overall | ≥ 85 % lines, ≥ 80 % branches |
| `apps/web` overall | ≥ 70 % lines |
| Requirements | Every R1–R13 row in §12 has passing tests at each listed layer |
| Static | `tsc --noEmit` strict, ESLint (no warnings), Prettier check |

Coverage is a floor, not a goal. Review focuses on whether the invariants are asserted.

---

## 11. Definition of Done

A change is done when:

1. Its unit, integration and, where applicable, realtime and E2E tests are written and pass
   locally in the cloud container and in CI.
2. A new endpoint has: Zod schema in `shared`, integration tests (happy path + every documented
   error), and an authorization-matrix row.
3. A new socket event has: typed contract in `shared`, Zod validation, and a realtime test.
4. A change to the timer machine updates the exhaustive transition table and still passes all
   properties P1–P9.
5. A schema change includes the migration, any hand-written SQL, and an updated `INT-SCHEMA`
   assertion.
6. The relevant docs (ARCHITECTURE / API_DESIGN / DATABASE_DESIGN) are updated in the same commit.
7. There are no skipped or `.only` tests, and no new lint warnings.

---

## 12. Requirements traceability matrix

| Rule | Unit / property | Integration | Realtime | E2E |
|---|---|---|---|---|
| **T-R1** Independent timer | Machine is per-session; no cross-user effects | INT-SESS (other user's session → 404), SEC-1, SEC-2 | RT-5, RT-7, RT-12 | E2E-2, E2E-12 |
| **T-R2** No shared timer | No room-scoped timer event exists in the contract (type-level test on event maps) | INT-SCHEMA (`rooms` has no timer columns) | RT-12 | E2E-2 |
| **T-R3** Break ≠ study | P1, P2, break effect ordering | INT-ACC, invariants A–D | — | E2E-3 |
| **T-R4** Breaks 5/10/15/30 | Machine table invalid durations, P4 | INT-SESS, INT-SCHEMA (CHECK) | — | E2E-3, E2E-4 |
| **T-R5** No auto resume | P3, machine table (system events never → `STUDYING`) | INT-RESILIENCE, invariant F, INT-SCHEMA (`evt_no_system_resume`) | RT-4 | E2E-3, E2E-6 |
| **T-R6** One active session | P9 | CT-1, INT-SESS, invariant G | RT-5 | E2E-8 |
| **T-R7** Rooms reusable | — | INT-ROOMS | RT-3 | E2E-11 |
| **T-R8** Tasks sync in real time | Cache-bridge tests | INT-TASKS, CT-10, CT-11 | RT-10 | E2E-5 |
| **T-R9** Disconnect grace 2 min | P7, grace unit tests | INT-RESILIENCE, CT-7 | RT-4 | E2E-6 |
| **T-R10** Idle timeout 30 min | P6, idle unit tests | INT-RESILIENCE | RT-8 | E2E-7 |
| **T-R11** Streak 25 min / local day | Streak calculator unit tests | INT-ACC, INT-STATS | — | E2E-9 |
| **T-R12** UTC storage | Zod instant schema rejects offsets | INT-SCHEMA (all instants are `timestamptz`; DB `timezone=UTC`), SEC-7 | — | E2E-10 |
| **T-R13** Daily totals in user tz | `splitByLocalDay` + §6 matrix | INT-ACC, INT-STATS, invariant C | — | E2E-10 |

---

## 13. Manual exploratory checklist

Run before each release candidate, using the seed data and two or three real browsers or devices:

- [ ] Laptop sleep mid-session (< 2 min and > 2 min), then wake.
- [ ] Phone and laptop on the same account: commands on one reflect instantly on the other.
- [ ] Switch Wi-Fi networks mid-session.
- [ ] Browser tab in the background for 40 minutes during `STUDYING` (idle flow).
- [ ] A 30-minute break with the tab closed, then reopen after 45 minutes → `AWAITING_RESUME`.
- [ ] Change profile timezone mid-day, then check the dashboard and streak.
- [ ] A room with 20+ members: presence list, status updates and task sync remain responsive.
- [ ] Screen reader pass on the timer panel and break picker.
