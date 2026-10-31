# StudySync — Testing Strategy

> **Status: v1.0 FINAL — reconciled with the final spec. Awaiting approval.**
> Defines how every rule (R1–R18), interpretation (I-xx) and edge case (E-xx) in
> [ARCHITECTURE.md](./ARCHITECTURE.md) is proven. Test IDs used across the docs are defined here.

---

## Contents

1. [Principles](#1-principles)
2. [Pyramid and tools](#2-pyramid-and-tools)
3. [Environments and database isolation](#3-environments-and-database-isolation)
4. [Controlling time](#4-controlling-time)
5. [Test layers](#5-test-layers)
6. [Timezone and DST matrix](#6-timezone-and-dst-matrix)
7. [Invariants after every test](#7-invariants-after-every-test)
8. [Test data](#8-test-data)
9. [CI pipeline and gates](#9-ci-pipeline-and-gates)
10. [Definition of Done](#10-definition-of-done)
11. [Traceability matrix](#11-traceability-matrix)
12. [Testing checklist (per release)](#12-testing-checklist-per-release)

---

## 1. Principles

1. **Every rule is proven at more than one layer**: a pure unit or property test, an
   integration test against real PostgreSQL, and an end-to-end test where it is user-visible.
2. **Real database, real sockets.** Constraints, locks, transactions and time-splitting SQL
   are never mocked.
3. **No waiting on real time.** 30-minute breaks, 2-minute grace and 30-minute idle are tested
   in milliseconds through an injected `Clock` and test clock.
4. **Invariants over examples.** Property tests generate thousands of random histories and
   assert rules that must always hold.
5. **No flaky tests.** Fix the root cause. Never retry, skip or quarantine.
6. **Tests ship with the code**, step by step (DEVELOPMENT_ROADMAP).

---

## 2. Pyramid and tools

```
              ▲  E2E — Playwright, multi-browser rooms            ~18 scenarios
             ▲▲▲  Realtime — socket.io-client ↔ in-process server  ~45
           ▲▲▲▲▲▲  Integration + concurrency — Supertest + Postgres  ~250
       ▲▲▲▲▲▲▲▲▲▲▲▲  Unit + property — pure timer, utilities          ~350 + generated cases
```

| Tool | Use |
|---|---|
| Vitest | Unit, integration, realtime, concurrency |
| fast-check | Property tests (timer histories; SQL-vs-Luxon split) |
| Supertest | REST against the app factory |
| socket.io-client | Socket commands, presence and broadcasts against a real server |
| React Testing Library + user-event, MSW | Components and hooks |
| Playwright | E2E with several browser contexts; `page.clock`; `context.setOffline` |
| k6 + socket load script | Performance (Phase 5) |

---

## 3. Environments and database isolation

| Environment | Database | Notes |
|---|---|---|
| Cloud dev container | Local PostgreSQL 16 started by `scripts/dev-db.sh` | Chromium + Playwright pre-installed. **Do not run `playwright install`.** |
| GitHub Actions | `postgres:16` service | Same scripts |

- `globalSetup` builds `studysync_test_template` with `prisma migrate deploy` once. Each Vitest
  worker clones it (`CREATE DATABASE … TEMPLATE …`).
- Between tests, `TRUNCATE … RESTART IDENTITY CASCADE`. There is **no** rollback-wrapping,
  because concurrency tests need real commits and locks.
- Test env: `NODE_ENV=test`, `TZ=UTC`, `BCRYPT_COST=4`, and `ENABLE_TEST_CLOCK=true` for E2E only.

---

## 4. Controlling time

| Seam | Production | Tests |
|---|---|---|
| `Clock.now()` | System clock | `FakeClock.set()` / `advance(ms)` |
| Deadline scheduler (break-end pushes) | `setTimeout` | `ManualTimerPort.fireDue(now)` |
| Sweeper / lease tick | Intervals | `sweeper.runOnce()`, `lease.tick()` |
| SQL "now" | `$now` parameter from `Clock` (never `now()`) | Same `FakeClock` value |
| Browser clock (E2E) | Real | Playwright `page.clock` |
| Server clock (E2E) | Real | `POST /__test__/clock` (test builds only) |

`vi.useFakeTimers()` is never used together with real Postgres or sockets.

---

## 5. Test layers

### 5.1 Pure timer core (`packages/shared/test/timer`)

**Exhaustive transition table.** Every *phase × event variant* is a table row with its
expected result (next phase + effects, or rejection code). The test fails if any pair is
missing, so a new event can't be added without deciding its behavior everywhere.

| Phases | Event variants |
|---|---|
| `NO_SESSION`, `STUDYING`, `ON_BREAK`, `BREAK_OVER` | `start_study` (room matches presence / mismatch / solo), `take_break` (5, 10, 15, 30, and invalid 0, 1, 20, 25, 45, 60, −5, 7.5), `resume_study` (before / exactly at / after `ends_at`; caller in room / not in room), `end_study`, `set_session_task` (attachable / not), stale `sessionId`, move to room (solo → R; room A → B), liveness lost, liveness regained (before / at grace deadline), grace deadline, idle deadline |

Focused unit tests:

- **Break ≠ study:** `take_break` emits `CloseSegment(t)` before `OpenBreak(t)`; never both
  open at once.
- **No early or automatic resume:** `resume_study` at `ends_at − 1 ms` → `BREAK_NOT_OVER`; at
  `ends_at` → OK. No system event yields `STUDYING`.
- **Phase derivation:** `phaseOf` at `ends_at − 1 ms` / `ends_at` / `ends_at + 30 min`.
- **Auto-save choice:** earliest deadline wins; close instants are stamped at the
  deadline (idle) or the disconnect instant (grace), clamped to the open interval's start.
- **Room move:** a STUDYING move splits the segment at *t* with no gap and no overlap; the
  display total is unchanged.
- **Display helpers:** elapsed and countdown with positive and negative clock offsets.

**Property tests (fast-check; 10k runs locally, 100k nightly).** Random histories of
commands (valid and invalid), time advances (0 ms – 3 h), liveness loss and regain, room moves
and reconciles are checked against:

| ID | Property | Rule |
|---|---|---|
| P1 | Segments and breaks never overlap | R3 |
| P2 | Σ segments + Σ break time ≤ session span; study time only accrues while `STUDYING` | R3 |
| P3 | Every entry into `STUDYING` is a user `start_study` / `resume_study` | R5 |
| P4 | Break durations ∈ {5,10,15,30}; resume only at `t ≥ ends_at`; a break never stays open past `ends_at + 30 min` | R4, R5, R10 |
| P5 | **Late-processing equivalence:** reconciling late gives the same result as processing each deadline on time (restart safety) | R9, R10 |
| P6 | `BREAK_OVER` for 30 min with no resume ⇒ `ENDED (IDLE_TIMEOUT)` at exactly `ends_at + 30 min` | R10 |
| P7 | Liveness regained < 2 min after loss ⇒ no phase change and the gap is credited; otherwise `ENDED (DISCONNECTED)` with nothing credited after the loss instant | R9 |
| P8 | `version` strictly increases | — |
| P9 | At most one active session; `ENDED` is terminal; a session's room changes at most once, from solo to a room | R6, R15 |

### 5.2 Time utilities and the SQL split

- Luxon helpers: IANA validation, "today" in a zone, local-date formatting.
- **P10 (integration property):** for 1,000 random `(zone, interval)` pairs drawn from
  `Intl.supportedValuesOf('timeZone')` within ±2 years, the **SQL midnight split**
  (DATABASE_DESIGN §6.1) equals a **Luxon reference split**, and both conserve total time.
  This guards against PostgreSQL tzdata vs ICU mismatches (ARCHITECTURE T2).
- Streak calculator unit tests over qualified-date lists: gaps, today vs yesterday, `atRisk`, empty history.

### 5.3 Server unit tests

JWT (pinned algorithm, `iss`/`aud`), password policy (72-byte limit with multi-byte input),
refresh hashing, room-code generator (alphabet, length, distribution), error mapping, env
validation (refuses the test clock in production), per-user queue ordering, socket token
buckets, presence store (multi-socket, one room per user, display grace), `isLive()` for
solo and room sessions, `EventCollector` (discarded on rollback).

### 5.4 Integration tests (REST + services + PostgreSQL)

| Suite | Covers |
|---|---|
| `INT-SCHEMA` | Every named constraint and index from DATABASE_DESIGN §5 exists, and direct SQL violating each is rejected: second ACTIVE session, studying+break on one row, 20-min break, wrong `ends_at`, resume before `ends_at`, break open past +30 min, idle close not exactly +30, overlapping segments, SYSTEM event entering `STUDYING`, bad room code (`O`, `0`, `I`, `1`, length 5/7). |
| `INT-AUTH` | Register (timezone), login, refresh rotation, reuse revokes the family, logout, cookie flags, CSRF |
| `INT-USERS` | Profile edits, timezone validation, timezone change affects only new segments |
| `INT-TASKS` | Personal: owner-only, idempotent add, set-semantics toggle, versioned edit, soft delete. Room: membership checks, delete rights, limits. `completed_by` / `completed_at` rules. |
| `INT-SESS` | Every command × phase through the real service. Rejection codes carry `details.session`. `commandId` replay. `STALE_SESSION`. Attach task. Solo and room rules (`MUST_START_IN_CURRENT_ROOM`, `SESSION_IN_OTHER_ROOM`, `NOT_IN_SESSION_ROOM`). Room move splits segments. Summary values (studied, breaks per I-12, where, task, completed tasks). |
| `INT-ACC` | Daily totals Solo / Rooms / Total via the split query on the §6 matrix. Running segment included. Sessions that end and restart merge per day. |
| `INT-STATS` | `today`, `daily` (zero-filled), `streak` (computed, I-11), `periods`, `heatmap`, range caps |
| `INT-ROOMS` | Create (code format, collision retry with a forced-collision generator), join by code (case-insensitive, idempotent, `INVALID_CODE`, `ROOM_FULL`), My Rooms order, member list with offline members, Today in this room (each member's own today), room history. Rooms persist with zero sessions (R7). |
| `INT-RESILIENCE` | Grace expiry via sweeper. Idle expiry via sweeper. Lease-lost detection. **Restart recovery:** a second app instance on the same DB with an empty presence store; overdue deadlines applied stamped at the deadline; break countdown still correct; no phase changes because of the restart. |

### 5.5 Concurrency tests (real parallelism, run 20× in CI, 100× nightly)

| ID | Scenario | Expected |
|---|---|---|
| CT-1 | 20 parallel `start_study` from 5 sockets of one user | Exactly 1 success, 19 × `SESSION_ALREADY_ACTIVE`. One ACTIVE row. |
| CT-2 | Parallel `take_break` + `end_study` + `resume_study` on one session | Serialized. Consistent final state. Valid intervals. Versions strictly increasing. |
| CT-3 | Same `commandId` × 10 in parallel | Applied once. One event row. Equal results. |
| CT-4 | `resume_study` exactly at `ends_at + 30 min` vs the sweeper | The deadline wins: `ENDED (IDLE_TIMEOUT)`, resume → `NO_ACTIVE_SESSION` (E-03) |
| CT-5 | Sweeper + scheduler + user command on one due session | Auto-save applied once. No duplicate events or intervals. |
| CT-6 | Solo session; two tabs `join_room` rooms A and B simultaneously | One move succeeds. The other gets `SESSION_IN_OTHER_ROOM`. |
| CT-7 | Forced overlapping segment or break insert (bypassing services) | Rejected by the GiST constraints |
| CT-8 | Two members `task_toggle {done: true}` at once | Final `DONE`, one `completed_by`, both acked with the final version |
| CT-9 | Two `task_update` with the same `expectedVersion` | One OK, one `VERSION_CONFLICT` with the current task |
| CT-10 | 10 users join a room with 1 free slot | Exactly one joins. Members ≤ 50. |
| CT-11 | Forced code collisions during parallel room creation | All rooms get unique codes (retry) |
| CT-12 | Two app instances on one DB, both sweeping and leasing | Each auto-save happens exactly once. A lease held on one instance isn't marked stale by the other. |

### 5.6 Realtime tests (in-process server + real `socket.io-client`)

| ID | Scenario |
|---|---|
| RT-1 | Handshake: valid, missing, invalid, expired token, > 5 sockets. `session_state` (cause `CONNECT`) arrives immediately, with `lastAutoSaved` when applicable. |
| RT-2 | `join_room` by a non-member → `NOT_FOUND`, and no room broadcasts are ever received |
| RT-3 | Presence and statuses: `member_joined`; `status_changed` for start, break (with `breakEndsAt`), break over (`IDLE`, scheduled at `ends_at`), resume, end; all members listed with `OFFLINE`; one room presence per user |
| RT-4 | **Liveness and grace (R9):** closing one of two tabs → still live. Closing the room tab while the dashboard tab stays → grace (room session). `leave_room` → grace. Reconnect at +119 s → unchanged, gap credited. No reconnect → `ENDED (DISCONNECTED)` at T, `member_left` after 2 min. Reconnect racing disconnect → no spurious grace. |
| RT-5 | `session_state` reaches all of my sockets and none of anyone else's (R1) |
| RT-6 | Version ordering (ack vs broadcast in either order). Rolled-back transaction emits nothing. |
| RT-7 | Room move: `join_room` while solo-studying → `MOVED_TO_ROOM`, elapsed unchanged. Study with friends flow. `SESSION_IN_OTHER_ROOM` leaves presence untouched. |
| RT-8 | Idle: `BREAK_OVER` push at `ends_at`; auto-save push at `ends_at + 30 min`; the member stays present as `IDLE` (no session) |
| RT-9 | `auth_renew` extends a socket. Expiry without renewal → `auth_expired` + disconnect, then reconnect within grace (no timer impact). |
| RT-10 | `room_task_updated` reaches present members of that room within 1 s, never other rooms. `personal_task_updated` reaches only my devices. |
| RT-11 | Payload validation (`VALIDATION_ERROR`) and per-event rate limits (`RATE_LIMITED`) |
| RT-12 | **No shared timer (R2):** with A and B in one room, A's commands change only A's `session_state` stream. A type-level test asserts the event map contains no room-timer event. |

### 5.7 Frontend tests

Timer panel per phase. Break picker renders **exactly** 5/10/15/30. Resume is disabled until
the corrected clock reaches `endsAt`, and nothing is sent automatically at 0. Countdown and
elapsed use the server offset. Members list (🟢/🟡 countdown/⚪/⚫, reconnecting hint). Today in
this room live tick. "Back to room" banner countdown. Summary screen. Task list
(add/toggle/edit/delete, conflict message). Cache bridge drops stale versions. Single-flight
token refresh. XSS strings render as text. Accessibility checks on key pages.

### 5.8 End-to-end (Playwright; server with test clock)

| ID | Scenario | Phase |
|---|---|---|
| E2E-0 | **Spike:** two browsers in one room. Live statuses and break countdown. Refresh keeps elapsed time. Break → Break Over → no auto resume → Resume. | 0 |
| E2E-1 | Register (timezone auto-detected) → logout → login → reload stays logged in | 1 |
| E2E-2 | Solo: start → 10-min break → Resume blocked → +10 min → Break Over → Resume → End → summary numbers exact | 1 |
| E2E-3 | Break picker shows only 5/10/15/30. A crafted socket payload with 20 → rejected. | 1 |
| E2E-4 | Solo 30 min → **Study with friends** → room created → timer continues → TODAY Solo 30m / Rooms running | 2 |
| E2E-5 | Join by code while solo-studying → session moves. Entering a second room's code → "End Study first". | 2 |
| E2E-6 | Two tabs click Start Study at once → one session, both tabs show it | 1 |
| E2E-7 | Three members: independent timers. A's break shows to others as "On Break mm:ss". Others unaffected. | 2 |
| E2E-8 | Room tasks: A adds, B checks off, C sees it within 1 s. Concurrent edit → conflict message. | 2 |
| E2E-9 | `context.setOffline` 90 s → still studying, nothing lost. Offline > 2 min → auto-saved at disconnect, member Offline, summary on return. | 2 |
| E2E-10 | Break over + 30 min (test clock) → auto-saved (`IDLE_TIMEOUT`); the member shows Idle | 2 |
| E2E-11 | User in Asia/Kolkata studies 23:30–00:30 → history shows 30 + 30 min on two days | 1 |
| E2E-12 | Room reuse: leave, next day rejoin from My Rooms. Tasks and membership persist; Today in this room starts fresh. | 2 |
| E2E-13 | Today in this room: three members' values correct and ticking live | 2 |
| E2E-14 | Streak: 24 min → not counted; 25 min → counted; consecutive days increment; a skipped day resets | 3 |
| E2E-15 | Weekly and monthly charts match `/stats/periods` | 3 |
| E2E-16 | Break-end browser notification + sound fire at 0 and never resume the timer | 4 |
| E2E-17 | Saved-session toast after a disconnect auto-save, shown exactly once | 4 |

### 5.9 Security tests

| ID | Test |
|---|---|
| SEC-1 | **Authorization matrix** (API_DESIGN §11) executed table-driven for every REST endpoint and socket event × {anonymous, non-member, member, room creator, task creator, other user} |
| SEC-2 | IDOR: another user's session id / summary, another room's tasks, a personal task by id → `404` |
| SEC-3 | JWT: `alg: none`, wrong secret, expired, wrong `iss`/`aud`, tampered `sub` (REST and handshake) |
| SEC-4 | Refresh rotation and reuse detection |
| SEC-5 | CSRF header and cookie flags |
| SEC-6 | Rate limits incl. code guessing (`POST /rooms/join`) → `429` |
| SEC-7 | Validation: unknown keys, oversize bodies and messages, malformed UUIDs, non-UTC instants, invalid timezones, invalid break durations |
| SEC-8 | Stored XSS in room names, task titles and descriptions renders inert |
| SEC-9 | No response or event ever contains `password_hash`, token hashes or refresh tokens |
| SEC-10 | Test clock: boot refuses it in production; the route `404`s when disabled |
| SEC-11 | Socket: no room events after failed `join_room`; socket cap; event rate limits |
| SEC-12 | Log redaction of auth headers, cookies and passwords |
| SEC-13 | CI: `npm audit --audit-level=high`, secret scanning, lint bans on `$queryRawUnsafe` and `dangerouslySetInnerHTML` |

### 5.10 Performance (Phase 5)

| ID | Target |
|---|---|
| PERF-1 | Socket timer command p95 < 150 ms at 200 commands/s |
| PERF-2 | 50 rooms × 50 members: `status_changed` / `room_task_updated` fan-out p95 < 500 ms |
| PERF-3 | Sweeper lag (processing − deadline) p95 < 2 s with 10k active sessions |
| PERF-4 | `/stats/daily` (1 year), `/stats/streak` (3 years of history), `/rooms/:id/today` p95 < 200 ms |

---

## 6. Timezone and DST matrix

Used by `INT-ACC`, P10, streak tests and E2E-11. The first seven rows were **already
validated against PostgreSQL 16** during design (DATABASE_DESIGN §6.1).

| Zone / case | Expected |
|---|---|
| Asia/Kolkata 23:30–00:30 local | 30 min + 30 min |
| America/New_York 26.5 h across fall-back 2026-11-01 | 60 · 1500 · 30 min (25 h day) |
| America/New_York 25 h across spring-forward 2026-03-08 | 60 · 1380 · 60 min (23 h day) |
| America/Santiago 2026-09-06 (midnight does not exist) | Boundary at the jump instant: 30 + 30 min |
| Australia/Lord_Howe 2026-04-05 (30-min shift) | 1470 min (24.5 h day) |
| Segment ending exactly at local midnight | One piece only |
| Pacific/Kiritimati (+14) vs Pacific/Pago_Pago (−11), same instant | Different local dates |
| Europe/London 2026-03-29 / 2026-10-25 | 23 h / 25 h days |
| Asia/Kathmandu (+05:45) | Quarter-hour offset split |
| Timezone change mid-day (Kolkata → New York) | Old segments keep the old snapshot. "Today" switches. Streak logic over local dates still holds (I-10). |
| "Today in this room" with members in Kolkata and New York | Each member's own local today (I-09) |

---

## 7. Invariants after every test

An `afterEach` hook in integration, concurrency and realtime suites runs the audit queries from
[DATABASE_DESIGN.md §8](./DATABASE_DESIGN.md#8-invariant-audit-queries). Any row fails the test:

| Audit | Asserts |
|---|---|
| A | No segment overlaps a break (R3) |
| B | Studying ⇔ exactly one open segment matching `current_segment_started_at` |
| C | On a break ⇔ exactly one open break matching `break_ends_at` |
| D | Ended sessions have nothing open, and all intervals lie inside the session window |
| E | Every entry into `STUDYING` was user-initiated (R5) |
| F | Every resumed break is followed by a segment at the same instant (no lost or extra time) |
| G | A room session's user is a member of that room (R16) |
| H | `rooms` has no timer-like columns (R2) |

---

## 8. Test data

- **Factories go through services**, not raw inserts: `createUser({ timezone })`,
  `createRoom(creator)`, `joinRoom(user, code)`, `connect(user)`, `joinPresence(socket, room)`,
  `startStudy(socket)`. The exceptions are `INT-SCHEMA` and CT-7, which deliberately bypass
  services.
- **Timeline builder** for readable scenarios:
  `timeline(alice).at('10:00').start().at('10:45').takeBreak(10).at('10:55').resume().at('11:35').end()`.
  It drives `FakeClock` + sockets and asserts `studiedMs = 85 min` (spec example).
- **Seed** (DATABASE_DESIGN §11) is for demos and manual QA; automated tests never depend on it.

---

## 9. CI pipeline and gates

```
npm ci ─┬─ lint · prettier --check · typecheck (all workspaces)
        ├─ unit + property (shared, server unit, web)
        ├─ integration + concurrency + realtime (postgres:16 service; invariants after each test)
        └─ build ─► e2e (Playwright Chromium, test clock; traces and videos on failure)
nightly: properties 100k runs · concurrency ×100 · P10 with 10k pairs · npm audit · invariant audit on seed DB
manual:  performance suite
```

| Gate | Threshold |
|---|---|
| `packages/shared/src/timer/**` | 100 % lines and branches |
| `apps/server/src/modules/sessions/**`, `presence/**` | ≥ 95 % lines, ≥ 90 % branches |
| `apps/server` overall | ≥ 85 % lines, ≥ 80 % branches |
| `apps/web` overall | ≥ 70 % lines |
| Lint / typecheck | Zero errors, zero warnings |
| Traceability | Every row of §11 has passing tests at each listed layer |

---

## 10. Definition of Done

1. Code + tests for the step pass locally (cloud container) and in CI.
2. New REST endpoint or socket event: Zod schema in `shared`, happy-path + every documented
   error tested, authorization-matrix rows added.
3. Timer change: transition table updated, P1–P10 still pass.
4. Schema change: migration + hand-written SQL + `INT-SCHEMA` assertion.
5. Docs updated in the same commit. No skipped or `.only` tests. No new warnings.

---

## 11. Traceability matrix

| Rule | Unit / property | Integration / concurrency | Realtime | E2E |
|---|---|---|---|---|
| **T-R1** Independent timer | Machine is per-user | INT-SESS, SEC-1, SEC-2 | RT-5, RT-12 | E2E-0, E2E-7 |
| **T-R2** No shared timer | Event-map type test | Audit H | RT-12 | E2E-7 |
| **T-R3** Break ≠ study | P1, P2 | INT-SESS, INT-ACC, audits A, F | — | E2E-2 |
| **T-R4** 5/10/15/30 only | Machine table, P4 | INT-SCHEMA, INT-SESS | RT-11 | E2E-3 |
| **T-R5** No auto resume; resume after countdown | P3, P4 | INT-SCHEMA, audit E | RT-3, RT-8 | E2E-0, E2E-2 |
| **T-R6** One active session | P9 | CT-1, CT-2, CT-6 | RT-5 | E2E-6 |
| **T-R7** Rooms reusable | — | INT-ROOMS | — | E2E-12 |
| **T-R8** Room tasks real-time | Cache bridge | INT-TASKS, CT-8, CT-9 | RT-10 | E2E-8 |
| **T-R9** Disconnect grace → auto-save | P5, P7 | INT-RESILIENCE, CT-5, CT-12 | RT-4 | E2E-9 |
| **T-R10** Idle 30 min → auto-save | P4, P5, P6 | INT-SCHEMA, INT-RESILIENCE, CT-4 | RT-8 | E2E-10 |
| **T-R11** Streak from history | Streak calculator | INT-STATS | — | E2E-14 |
| **T-R12** UTC storage | Zod instant schema | INT-SCHEMA (`timestamptz`, DB timezone) | — | E2E-11 |
| **T-R13** Local-day totals | P10 | INT-ACC, §6 matrix | — | E2E-11 |
| **T-R14** Server is the source of truth | No client-instant fields in any schema (type test) | SEC-7 | RT-11 | E2E-0 |
| **T-R15** One room per session; solo moves in | P9 | INT-SESS, CT-6 | RT-7 | E2E-4, E2E-5 |
| **T-R16** Membership ≠ presence ≠ session | — | INT-ROOMS, audit G | RT-3, RT-4 | E2E-12 |
| **T-R17** Room code format and uniqueness | Generator unit test | INT-SCHEMA, INT-ROOMS, CT-11 | — | E2E-5 |
| **T-R18** Room tasks only for members | — | SEC-1, SEC-2 | RT-2, RT-10 | E2E-8 |

---

## 12. Testing checklist (per release)

**Automated (must be green):**
- [ ] Lint, typecheck, unit, property (P1–P10)
- [ ] Integration suites + invariant audits A–H after every test
- [ ] Concurrency CT-1–CT-12 (×20)
- [ ] Realtime RT-1–RT-12
- [ ] E2E for every phase delivered
- [ ] SEC-1–SEC-13 · `npm audit` · secret scan
- [ ] Performance PERF-1–PERF-4 (release candidates)

**Manual (cloud recordings or real devices):**
- [ ] Two or three browsers in one room: statuses, countdowns and Today in this room look right
- [ ] Refresh during studying, during a break, and during Break Over
- [ ] Wi-Fi off < 2 min and > 2 min. Laptop sleep during a break (D-5 behavior).
- [ ] Phone + laptop on one account: commands on one reflect on the other
- [ ] Study across local midnight; change timezone mid-day
- [ ] "Study with friends" mid-session; joining a second room is blocked
- [ ] Server restart mid-session (with fast and slow reconnect)
- [ ] Keyboard-only and screen-reader pass on the timer and the room screen
