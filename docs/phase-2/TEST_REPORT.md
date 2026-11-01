# StudySync — Phase 2 Test Report: Rooms and Real-Time Synchronization

|             |                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch      | `feature/phase-2-rooms` (from Phase 1, `a25c4eb`)                                                                                                       |
| Date        | 2026-11-01                                                                                                                                              |
| Environment | Claude Code cloud container · Node 22 · PostgreSQL 16 · Chromium (Playwright 1.63.0)                                                                    |
| Verdict     | **All 14 requested features delivered. 290 automated tests + 21 E2E tests pass** (Phase 2 E2E three consecutive runs without a flake). Phases 0–1 kept. |

---

## 1. Results summary

| Suite                                                                                          |   Tests | Result           |
| ---------------------------------------------------------------------------------------------- | ------: | ---------------- |
| Timer core — user commands (exhaustive table) + focused + properties                            |     119 | ✅               |
| **Timer core — system transitions (new)**: exhaustive phase × event table, P5, P6, P7, RT-12     |      31 | ✅               |
| Shared contract, web unit, server unit                                                          |      47 | ✅               |
| **INT-ROOMS (new)**: codes, join by code, D-3 / CT-10, CT-11, My Rooms, SEC-2, SEC-6             |       8 | ✅               |
| **Rooms over sockets (new)**: RT-2, RT-3, RT-12, RT-10 / CT-8 / CT-9, Today, RT-7, CT-6          |       7 | ✅               |
| **Liveness and auto-save (new)**: RT-4a, RT-4b, RT-8, CT-4, INT-RESILIENCE (restart), CT-12      |      10 | ✅               |
| Phase 0 acceptance + Phase 1 suites (schema, auth, stats, solo) — unchanged behaviour            |      68 | ✅               |
| **Total automated (Vitest)**                                                                    | **290** | ✅ **290 / 290** |
| E2E: Phase 0 (8, now with a real room) + Phase 1 (6) + **Phase 2 (7, three browsers)**          |      21 | ✅ **21 / 21**   |
| Typecheck (4 workspaces) · ESLint · Prettier                                                    |       — | ✅ clean         |

Every DB-backed test ends with the DATABASE_DESIGN §8 audits (A–H) returning no rows.

**Mutation check** (both reverted):

1. Grace auto-save closes the interval at the deadline instead of the disconnect instant →
   **5 tests failed** (system table, P7, RT-4a, room grace, restart).
2. Room sessions treated as live with any socket (solo rule) → **RT-4b failed**.

## 2. Features → evidence

| #   | Feature                       | Evidence                                                                                                                                                                    |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create room                   | INT-ROOMS create (name rules, creator is a member, 20/day); dashboard "Create"; E2E-4/5                                                                                     |
| 2   | Unique codes                  | 6 chars from the 32-char alphabet via `crypto.randomInt`; DB unique + format check; CT-11 forced collisions → all unique                                                     |
| 3   | Join by code                  | Case-insensitive, idempotent, uniform `INVALID_CODE`, `ROOM_FULL` at 50 (CT-10: 10 racers, 1 slot → exactly 1), rate limited (10/min); `/join/CODE` link                    |
| 4   | My Rooms                      | Most recently visited first; one-click rejoin (E2E-12)                                                                                                                      |
| 5   | Leave and rejoin              | `leave_room` ends presence only; membership stays (D-2); room stays in My Rooms; E2E-12                                                                                      |
| 6   | Real-time member statuses     | RT-3: 🟢 / 🟡 with countdown / ⚪ / ⚫ and "reconnecting"; all members listed, absent ones Offline (I-18); E2E-7                                                            |
| 7   | Independent timers            | RT-12: A's break produces no `session_state` for B or C; B's version and elapsed unchanged; E2E-7                                                                           |
| 8   | Shared room tasks             | RT-10: add / toggle (set semantics) / versioned edit / delete rights (task or room creator); non-members get 404 and no broadcasts; E2E-8 (seen within 1 s)                  |
| 9   | Today in this room            | Each member's own local today (Kolkata and New York members), running segments included; in the `join_room` ack; E2E-7                                                       |
| 10  | Solo → room without resetting | RT-7: elapsed unchanged after the move, TODAY 30 min solo + rooms running, summary "Solo → Friends"; CT-6 two tabs into two rooms → one move; E2E-4 / E2E-5                   |
| 11  | 2-minute disconnect grace     | RT-4a (solo: any socket keeps it live; back at +119 s → nothing lost); RT-4b (room: only presence in that room); auto-saved at the loss instant; other users untouched        |
| 12  | 30-minute idle timeout        | RT-8: auto-saved at exactly `ends_at + 30 min`; member stays Idle; CT-4: a resume at the deadline loses to it; E2E-10                                                        |
| 13  | Reconnection and recovery     | `RECONNECTED` with the phase unchanged; INT-RESILIENCE: crash + new instance on the same DB — lease lost at `last_seen_at`, reconnect in time → nothing lost; otherwise saved, events stamped as if on time |
| 14  | Member synchronization        | `member_joined` / `status_changed` / `member_left` with versions; `join_room` snapshot (members, tasks, today, session); E2E-9 "reconnecting" then restored                    |

## 3. Required constraints

| Constraint                                         | Verified by                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Never a shared timer                               | RT-12 (type-level event map + stream checks), audit H (`rooms` has no timer columns)                |
| One user's break or disconnect never affects others | RT-4b (B's session version/elapsed unchanged while A is away), RT-3, E2E-7, E2E-10                  |
| Preserve all study segments                        | Audits A–F after every test; room moves split segments (`ROOM_MOVE`), auto-saves only close the open one |
| Auto-save survives restarts                        | INT-RESILIENCE (3 tests), P5 property (late = on time), sweeper at boot                              |
| Room operations validated on the backend           | Membership checks on every room read/event (404), Zod schemas, ROOM_FULL under a row lock, rate limits |

## 4. E2E (Phase 2, three browsers)

E2E-4 Study with friends · E2E-5 join while studying + "End Study first" · E2E-7/13 three
members, countdown, Today · E2E-8 room tasks within 1 s · E2E-9 (navigation) "Back to room —
saves in 1:59", back in time → nothing lost · E2E-10 idle auto-save + notice · E2E-12 leave and
rejoin from My Rooms. Screenshots:
[room](./screenshots/01-room-three-members.png) · [room tasks](./screenshots/02-room-tasks.png) ·
[back-to-room banner](./screenshots/03-back-to-room-banner.png) ·
[idle auto-save notice](./screenshots/04-idle-auto-saved.png)

## 5. Implementation notes (for review)

- **Lease refresh cadence:** the liveness lease is refreshed on every sweeper tick (5 s) rather
  than every 30 s; same rule, one batched UPDATE per tick. The test clock refreshes the lease
  inside the same exclusive section, so a clock jump is never mistaken for a crash.
- **Grace close instant:** a closing command (`take_break`, `end_study`) is allowed during grace.
  If one happened, the auto-save closes at `max(disconnected_at, start of the open interval)`
  so `ended_at` never precedes a recorded interval (audit D).
- **Leaving the room screen** (navigating away) ends that tab's presence by reconnecting its
  socket; the Leave button sends `leave_room` (all of the user's sockets), as specified.
- **Shutdown** is treated like the crash path: disconnects are not processed, so a restart never
  starts anyone's grace; the lease and the clients' reconnect decide.
- The Phase 0 prototype room is no longer special: it is the seed's demo room (code `DSA7K2`).

## 6. Not covered (by design or later phases)

- E2E-9's `context.setOffline` variant and E2E-18 (solo browsing across tabs) are covered at the
  socket level (RT-4a / RT-4b) rather than in the browser.
- Room history (Phase 4), weekly/monthly stats (Phase 3), polished notifications (Phase 4).
