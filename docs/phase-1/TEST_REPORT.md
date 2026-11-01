# StudySync — Phase 1 Test Report: Core Application

|             |                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch      | `feature/phase-1-core-app` (from Phase 0, `94e96a8`)                                                                                                  |
| Date        | 2026-11-01                                                                                                                                            |
| Environment | Claude Code cloud container · Node 22.23.4 · PostgreSQL 16 · Chromium (Playwright 1.63.0)                                                             |
| Stack added | Prisma 6.19 · jsonwebtoken 9 (HS256) · bcryptjs 3 · cookie-parser · express-rate-limit 8 · React Router 8 · supertest 7                              |
| Verdict     | **All 14 Phase 1 features delivered. 234 automated tests + 14 E2E tests pass** (Phase 1 E2E three consecutive runs without a flake). Phase 0 preserved. |

---

## 1. Results summary

| Suite                                                                                                 | Tests | Result |
| ----------------------------------------------------------------------------------------------------- | ----: | ------ |
| Timer core — exhaustive transition table (4 phases × 25 events + completeness check)                  |   101 | ✅     |
| Timer core — focused tests (incl. new row 12: attach / clear a task)                                  |    14 | ✅     |
| Timer core — property tests P1–P4, P8, P9                                                             |     4 | ✅     |
| Shared contract — account schemas, byte-length passwords, IANA zones, local-date helpers              |    33 | ✅     |
| Web unit — session version guard, task ordering                                                       |     3 | ✅     |
| Server unit — queue, scheduler, rate limiter, environment guard                                       |    11 | ✅     |
| **INT-SCHEMA** — every §5 constraint/index exists; violating SQL rejected (incl. CT-7)                |    11 | ✅     |
| **INT-AUTH / INT-USERS / SEC-3…SEC-7** — REST on PostgreSQL                                           |    12 | ✅     |
| **INT-ACC / INT-STATS** — §6.1 DST matrix, D-6 snapshot, today, daily, streak                         |    13 | ✅     |
| **INT-SESS / INT-TASKS / CT / RT / SEC-2** — solo timer, tasks, sockets (real server, real clients)   |    14 | ✅     |
| Phase 0 acceptance suite — now on PostgreSQL with real JWTs                                           |    18 | ✅     |
| **Total automated (Vitest)**                                                                          | **234** | ✅ **234 / 234** |
| E2E (Playwright): Phase 0 two-browser suite (now with real accounts) + Phase 1 flows                  |    14 | ✅ **14 / 14** |
| Typecheck (4 workspaces) · ESLint · Prettier                                                          |     — | ✅ clean |

After **every** DB-backed test the invariant audits of DATABASE_DESIGN §8 (A–H) run against
the database and must return no rows.

**Mutation check** (proving the tests can fail; both reverted):

1. Store every segment's timezone as `UTC` instead of the user's zone → **10 tests failed**
   (the whole DST matrix, the D-6 snapshot test, the solo flow, the streak midnight test).
2. Disable refresh-token family revocation on reuse → **SEC-4 failed**.

---

## 2. Features → evidence

| #   | Feature                         | Evidence                                                                                                                                                                                                  |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PostgreSQL via Prisma           | Schema verbatim from DATABASE_DESIGN §4; migration includes all §5 SQL; INT-SCHEMA; `prisma migrate deploy` on fresh test/E2E databases                                                                    |
| 2   | Registration and login          | INT-AUTH (normalized email, uniform login failure, duplicate → `EMAIL_TAKEN`, byte-length passwords, unknown keys); E2E-1                                                                                 |
| 3   | JWT authentication              | SEC-3 (wrong secret, `alg: none`, HS512, wrong iss/aud, tampered `sub`, expired → `TOKEN_EXPIRED`); RT-1 handshake; RT-9 `auth_renew` / `auth_expired`; SEC-4 rotation + reuse; SEC-5 CSRF + cookie flags |
| 4   | Profile and timezone            | INT-USERS (name, IANA validation incl. PostgreSQL's zone list, legacy ids mapped); Settings page                                                                                                         |
| 5   | Personal dashboard              | Timer, TODAY Solo/Rooms/Total (live), streak, tasks, room link (screenshot 02)                                                                                                                            |
| 6   | Personal task CRUD              | INT-TASKS (idempotent add, set-semantics toggle, versioned edit → `VERSION_CONFLICT`, soft delete, ordering), CT-8, CT-9, SEC-2, RT-5 push to my other tabs; E2E tasks                                    |
| 7   | Individual study timer          | INT-SESS solo flow; every illegal command rejected with `details.session`; C3 replay; CT-1 (20 parallel starts → 1 session); E2E-6 (two tabs → one session)                                               |
| 8   | Breaks 5/10/15/30               | Schema, machine table, DB constraints, E2E-3 (four buttons; crafted 20-min payload → `VALIDATION_ERROR`)                                                                                                  |
| 9   | Manual resume after expiry      | `BREAK_NOT_OVER` at T−1 ms with `breakEndsAt`; `BREAK_OVER` push; still paused 7 min later; E2E-2                                                                                                         |
| 10  | Server-side segment recording   | Rows asserted: two segments (25 + 15 min) with the user's timezone snapshot, one break, five events; audits A–F                                                                                          |
| 11  | End-of-session summary          | Exact summary (40 min studied, 1 break / 10 min, Solo, task, completed task); REST summary = socket summary; live partial summary; foreign session → 404                                                  |
| 12  | Daily totals                    | §6.1 matrix: Kolkata 30+30, New York fall-back 60/1500/30 and spring-forward 60/1380/60, Santiago, Lord Howe 1470, exact midnight, Kiritimati vs Pago Pago; break excluded; running segment; E2E-11         |
| 13  | Study history                   | Keyset pagination, newest first, invalid cursor → 400; History page; E2E-2 / E2E-11                                                                                                                       |
| 14  | 25-minute streak                | 24:59 doesn't count; 15 + 10 on one day counts; "at risk" until today qualifies; a gap resets `current`, keeps `longest`; computed from history                                                           |

## 3. Product rules

| Rule                        | Verified by                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Never a shared timer        | RT-5 (no cross-user `session_state`), audit H, Phase 0 AC-2/3/5                                         |
| Break time never counts     | Audits A/F, INT-ACC break exclusion, summaries, E2E-2                                                   |
| One active session per user | Unique index (INT-SCHEMA), advisory lock + row lock, CT-1, E2E-6                                        |
| Server controls timestamps  | Strict schemas (SEC-7), injected clock everywhere, SQL takes `$now` (no `now()` in time logic)          |
| Days in the user's timezone | §6.1 matrix, D-6 snapshot test (history unchanged after moving Kolkata → New York)                      |

## 4. E2E

| Test                                                                | Result |
| ------------------------------------------------------------------- | ------ |
| Phase 0 suite 1–8 (two browsers, now registering real accounts)     | ✅ 8/8 |
| E2E-1 register (zone detected) → logout → login → reload            | ✅     |
| Personal tasks add / edit / complete / delete, synced to another tab | ✅     |
| E2E-2 solo session with a 10-minute break and exact summary         | ✅     |
| E2E-3 only 5/10/15/30; crafted 20-minute payload rejected           | ✅     |
| E2E-6 two tabs click Start at once → one session                    | ✅     |
| E2E-11 Asia/Kolkata 23:30–00:30 → 30 + 30 min on two days           | ✅     |

E2E-11 fast-forwards the server clock 13 hours, which expires every access token: the browser
refreshes and reconnects on its own, so the token-renewal path is exercised end to end too.

Screenshots: [01 register](./screenshots/01-register.png) ·
[02 solo on break](./screenshots/02-solo-on-break.png) ·
[03 summary](./screenshots/03-solo-summary.png) ·
[04 history, midnight split](./screenshots/04-history-midnight-split.png)

## 5. Issues found and fixed during testing

| Issue                                                                                                   | Fix                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chrome reports India as `Asia/Calcutta`; PostgreSQL without tz "backward" links rejects it → users in India could not register | Legacy browser zone ids are mapped to their current IANA names at every boundary (shared schema + client) |
| Room members ordered randomly when they joined at the same instant                                      | Ordered by name, as DATABASE_DESIGN §6.5                                                              |
| E2E-6 flake: the second tab's Start button vanished before Playwright clicked it                        | Both clicks dispatched in the same instant (test only)                                                 |

## 6. Known limitations (by design until later phases)

- Disconnect / idle **auto-save arrives in Phase 2**: an abandoned session stays active.
  The D-5 break hint already shows its wording.
- Only the prototype room exists; room creation, join-by-code, room tasks and "today in this
  room" are Phase 2.
- Prisma blocks `migrate reset` when run by an AI agent, so tests and E2E use
  `prisma migrate deploy` on dedicated `*_test` / `*_e2e` databases and clear their tables.
