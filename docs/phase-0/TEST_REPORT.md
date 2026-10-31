# StudySync — Phase 0 Test Report: Real-Time Technical Prototype

| | |
|---|---|
| Branch | `feature/phase-0-realtime-prototype` (from the approved-docs branch) |
| Date | 2026-10-31 |
| Environment | Claude Code cloud container · Node 22.23.4 · npm 10.9.9 · Chromium 153 (Playwright 1.63.0) |
| Stack | React 19.3 · Vite 8.3 · Tailwind 4.3 · Express 5.3 · Socket.IO 4.8 · Zod 4.3 · TypeScript 5.9 (strict) · Vitest 5.0 |
| Verdict | **All 9 required acceptance criteria PASS.** 178 automated tests + 8 two-browser E2E tests pass (three consecutive E2E runs without a flake). **CI green on GitHub.** |

---

## 1. Results summary

| Suite | Tests | Result |
|---|---:|---|
| Timer core — exhaustive transition table (4 phases × 23 events + completeness check) | 93 | ✅ pass |
| Timer core — focused tests (break ≠ study, no early or automatic resume, room move, boundaries) | 13 | ✅ pass |
| Timer core — property tests P1–P4, P8, P9 (10,000 random histories each; also passed at 50,000) | 4 | ✅ pass |
| Shared contract — schemas (break durations, no client time) and display helpers | 28 | ✅ pass |
| Server unit — store integrity rules (mirror of the database constraints) | 12 | ✅ pass |
| Server unit — per-user queue, deadline scheduler, rate limiter, environment guard | 10 | ✅ pass |
| Server realtime — Phase 0 acceptance (real server + real Socket.IO clients) | 18 | ✅ pass |
| **Total automated (Vitest)** | **178** | ✅ **178 / 178** |
| Two-browser E2E (Playwright, real UI, two browser contexts) | 8 | ✅ **8 / 8** (×3 runs) |
| Typecheck (all 4 workspaces) · ESLint (54 files) · Prettier | — | ✅ clean |

**Mutation check.** To prove the tests can fail, two real bugs were injected into the timer core:
1. allowing a resume before the break ends → **6 tests failed** (table, focused, property P4, realtime AC-4, AC-8);
2. not closing the study segment when a break starts (break counted as study) → **13 tests failed**.

Both were detected at every layer. The code was restored and all tests passed again.

---

## 2. Required acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Two browsers join the same room | ✅ PASS | Realtime AC-1 (both listed, `member_joined`, presence grace → Offline after 2 min). E2E 1. |
| 2 | Both users start independent timers | ✅ PASS | AC-2: distinct sessions; each `session_state` only describes the receiver's own session; elapsed 5:00 vs 4:00 after staggered starts. E2E 2: different elapsed values in the two browsers. |
| 3 | User A takes a break while user B continues | ✅ PASS | AC-3: A → `ON_BREAK`; B receives **no** `session_state`; B's segment and version unchanged; B sees A's `breakEndsAt`. E2E 3: B sees "On Break 04:58" and B's timer keeps counting. |
| 4 | User A resumes after break expiry | ✅ PASS | AC-4: resume rejected at T−1 ms (`BREAK_NOT_OVER`); server pushes `BREAK_OVER` exactly at the deadline; still not studying 20 min later; manual resume works; studied 30:00 with the 10-min break and 20 min of waiting excluded. E2E 5. |
| 5 | User A ends without affecting user B | ✅ PASS | AC-5: exact summary; B's stream contains only room-presence events; B's session unchanged. E2E 7: B's timer keeps running. |
| 6 | Browser refresh while studying | ✅ PASS | AC-6: reconnect rebuilds the exact elapsed time (10:01) from server timestamps. E2E 6: same elapsed time ± the real reload time. |
| 7 | Browser refresh while on break | ✅ PASS | AC-7: countdown rebuilt (11:00 left); a break that ended while the tab was closed shows `BREAK_OVER` (no automatic resume). E2E 4. |
| 8 | Invalid state transitions | ✅ PASS | AC-8 (6 tests): `NO_ACTIVE_SESSION`, `SESSION_ALREADY_ACTIVE`, `NOT_ON_BREAK`, `NOT_STUDYING`, `BREAK_NOT_OVER`, `STALE_SESSION`, `VALIDATION_ERROR` (breaks 0/1/20/25/45/60/−5/7.5/"10"/null; any client timestamp or duration field), `MUST_START_IN_CURRENT_ROOM`, `NOT_IN_SESSION_ROOM`, `NOT_FOUND`, `TASK_NOT_ATTACHABLE`, `UNAUTHENTICATED`, `TOO_MANY_CONNECTIONS`, `RATE_LIMITED`. Every rejection leaves state unchanged; session rejections carry `details.session`. Plus 92 transition-table rows. |
| 9 | Multiple simultaneous requests | ✅ PASS | CT-1: 20 parallel starts from 5 tabs → exactly 1 session. CT-2: parallel break/resume/end → exactly one break and one end, versions strictly increasing. CT-3: one `commandId` ×10 → applied once. Two users acting at once never affect each other. |

Product rules verified along the way:

| Rule | Verified by |
|---|---|
| No shared timer (R1/R2) | AC-2/3/5 (no cross-user `session_state`; room channel carries only presence and status events) |
| No automatic resume (R5) | AC-4, AC-7, E2E 5, property P3, store rule `evt_actor_matches_type` |
| Break time never counts (R3) | AC-4 / E2E 5 / E2E 7 summaries, property P1–P2, store rules `segment_break_no_overlap` and `seg_no_overlap_per_user` |
| Breaks 5/10/15/30 only (R4) | Schema tests, AC-8, E2E 3 (exactly four buttons), P4, store rule `brk_duration_allowed` |
| Server is the source of truth (R14) | Strict schemas reject `studyMs`, `startedAt`, `endsAt`, `durationMs`, `now` |
| Separate timer state per user | Per-user sessions and queue; AC-9 "two users at once" |

## 3. Roadmap Phase 0 acceptance (DEVELOPMENT_ROADMAP §3)

| Criterion | Result |
|---|---|
| Two browsers each start, break and resume independently | ✅ PASS |
| The other browser sees the status (and break countdown) **within 1 s** | ✅ PASS (E2E asserts a 1-second limit on 5 status changes) |
| A refresh while studying shows the same elapsed time (±1 s) | ✅ PASS |
| Resume is impossible before the countdown ends; nothing resumes automatically | ✅ PASS |
| CI is green | ✅ PASS — [CI run #1](https://github.com/Atharvaajain/StudySync/actions/runs/41222580382) |

## 4. TESTING_STRATEGY coverage for Phase 0

| Planned (§3 of the roadmap) | Status |
|---|---|
| Machine table (Phase 0 subset) | ✅ 92 rows + completeness check |
| P1–P5 | ✅ P1–P4, plus P8 and P9. **P5 deferred:** late-processing equivalence applies to auto-save deadlines, which arrive in Phase 2. In Phase 0 the only time-driven change, break → break over, is derived and writes nothing. |
| INT-SESS (spike subset) | ✅ covered by realtime AC-1…AC-9 |
| RT-1 (handshake) | ✅ AC-8 (missing/invalid identity, socket cap) + `session_state` on every connect |
| RT-3 (basic presence/status) | ✅ AC-1…AC-5 (`member_joined`, `status_changed` for start/break/break over/resume/end, reconnecting → Offline) |
| E2E-0 | ✅ 8 scenarios |
| INT-SCHEMA | **Replaced in Phase 0** by STORE-INVARIANTS (12 tests): no database exists in this phase (see §6) |
| Invariant audits after every test (§7) | ✅ the store's audit (equivalent of audits A–F) runs after every realtime test |

## 5. Issues found and fixed during Phase 0

| Issue | Found by | Fix |
|---|---|---|
| A fresh 5-minute break displayed **05:01**: the countdown rounded up, and push-based clock samples run a few ms behind the server | E2E 3 | Countdown rounds to the nearest second and is clamped to the break length. Clock offset is refined only from unbiased round-trip samples; pushes are used only to detect clock jumps. Unit tests added. |
| Clients whose own session never changes would never re-measure the clock offset | Design review during E2E | Periodic clock sampling every 30 s (median of samples, per ARCHITECTURE §16.2) |
| Joining with a solo session briefly broadcast the joiner as Offline | Code review | Presence is recorded before the session moves into the room |
| Shared package tests needed Node types; the shared source must not have them | Typecheck | Separate `tsconfig.test.json`; the shared source stays browser-safe |

## 6. Deviations from the approved roadmap (need your decision)

Phase 0 follows **your Phase 0 instructions**, which differ from DEVELOPMENT_ROADMAP §3 in these points. The approved documents have **not** been changed. I request approval to update them (§9).

| Roadmap step | Approved roadmap says | Implemented | Why |
|---|---|---|---|
| 0.2 / 0.3 | PostgreSQL + Prisma, full schema, `INT-SCHEMA` | **In-memory store** that mirrors the approved tables and enforces the same integrity rules under the same names; `STORE-INVARIANTS` tests | Your Phase 0 scope: "Do not implement production database integration"; the stack list has no database |
| 0.1 | Root scripts incl. `db:migrate`, `db:reset`, `db:seed` | Not created | No database in Phase 0 |
| 0.4 | `dueAutoSave()` in the timer core | Deferred to Phase 2, where it is used | Auto-save is out of Phase 0 scope |
| 0.6 | Dev-only JWT identity endpoint | **Prototype identity**: name + random id in the handshake, no tokens, kept in `sessionStorage` | Your Phase 0 scope: "Do not implement authentication". The server refuses `NODE_ENV=production`. |
| 0.7 | Membership via the room | Entering the hardcoded room creates the (permanent) membership | Join-by-code is Phase 2 |
| 0.11 | CI with a `postgres:16` service | CI without a database service | No database in Phase 0 |
| API contract | `join_room` ack includes `today`; `SessionDto.autoSaveAt` / `disconnectedAt` | `today: null`, `autoSaveAt: null`, `disconnectedAt: null` | Phase 2 features; the field shapes are kept |

## 7. Known limitations (by design, Phase 0)

1. **In-memory only:** a server restart forgets sessions and memberships.
2. **No authentication:** identities are self-declared. This is safe only as a local prototype, so production mode is refused.
3. **No auto-save yet (Phase 2):** a closed tab leaves that user's session active indefinitely. The room shows them ⚫ Offline after the 2-minute display grace, and their timer is never affected by anyone else.
4. **Test-clock display artifact:** when E2E fast-forwards the server clock, a browser that receives no push about its own session catches up within 30 s (visible in screenshot 03, where Bob shows 00:05). Real clocks don't jump.
5. **Single server instance:** the per-user queue is in-process. Phase 1 adds database-level per-user locks.

## 8. CI

The workflow `.github/workflows/ci.yml` ran on GitHub Actions for commit `88bb85a`:
[run #1](https://github.com/Atharvaajain/StudySync/actions/runs/41222580382) — **success**.

| Job | Steps | Result |
|---|---|---|
| Typecheck · lint · format · unit + realtime tests | `npm ci`, typecheck, lint, format check, `npm test` (178 tests) | ✅ success |
| Two-browser E2E (Playwright) | `npm ci`, install Chromium, `npm run test:e2e` (8 scenarios) | ✅ success |

The same steps were also reproduced locally from a clean `npm ci`, with identical results.

## 9. Proposed documentation updates (awaiting your approval)

1. **DEVELOPMENT_ROADMAP §3:** record the actual Phase 0 scope (§6) and move steps 0.2, 0.3, the `db:*` scripts and `INT-SCHEMA` to the start of Phase 1.
2. **CLAUDE.md → "Project status" and "Commands":** Phase 0 complete (pending approval), and the real script list.
3. **TESTING_STRATEGY §5.4:** add `STORE-INVARIANTS` as the Phase 0 stand-in for `INT-SCHEMA`.

## 10. Demo artifacts

- Screenshots (two browsers side by side): `docs/phase-0/screenshots/01…04*.png`.
- Videos per browser: produced by `npm run test:e2e` in `e2e/.artifacts/videos/` (shared separately, not committed).

## 11. How to reproduce

```bash
npm install
```

```bash
npm run typecheck && npm run lint && npm test
```

```bash
CAPTURE_SCREENSHOTS=1 npm run test:e2e
```
