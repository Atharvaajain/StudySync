# StudySync — Production Readiness Review

| | |
|---|---|
| Branch | `feature/phase-3-finalization` (not merged into `main`) |
| Date | 2026-11-01 |
| Verdict | **Not production-ready yet.** All automated checks pass and the Vercel + Render + Neon setup was rehearsed locally, but two critical items remain open (§4): the D-4 account features and a real deployment check. |

## 1. Completed checks

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Requirements review (F-01…F-49, ARCHITECTURE §2) | ✅ with gaps in §3 | Each requirement mapped to code and tests |
| 2 | Static checks: TypeScript strict (4 workspaces), ESLint, Prettier | ✅ | `npm run typecheck / lint / format:check` |
| 3 | Unit tests: timer core (exhaustive user and system tables, P1–P9), shared contract, web, server | ✅ 199 | Vitest |
| 4 | Database + integration tests on PostgreSQL 16 (schema constraints, auth, rooms, stats, timezone, authorization matrix) | ✅ 52 | Vitest `server-db` |
| 5 | Real-time tests (real server + Socket.IO clients; solo, rooms, liveness, restart, multi-room, polling) | ✅ 52 | Vitest `server-db` |
| 6 | E2E (Chromium): Phases 0–3 + readiness (invite link, room errors) | ✅ 27 / 27 | Playwright |
| 7 | Invariant audit (DATABASE_DESIGN §8) after every DB test and on the rehearsal database | ✅ no violations | `npm run db:audit` |
| 8 | Requirement verification — timer, breaks, sessions, rooms, tasks, timezone, history, streak | ✅ | §2 |
| 9 | Security review — authentication, authorization, database access, input validation | ✅ | §5 |
| 10 | Responsive UI — 360 px (no horizontal scroll on every main screen) and 1280 px | ✅ | E2E + screenshots in `docs/phase-3/` |
| 11 | Production build (`npm run build`) and production-mode start with secure defaults | ✅ | Rehearsal |
| 12 | Backend alone (API-only, like Render) — `npm run smoke -- <url> --api-only` | ✅ 11 / 11 | Rehearsal |
| 13 | Through a Vercel-like proxy (static web, HTTP-only rewrites, no WebSocket) — smoke | ✅ 11 / 13, both misses expected (§6) | Rehearsal |
| 14 | Two real browsers through that proxy: rooms, live status over long-polling (82 ms), sign-in survives reload | ✅ | Rehearsal |
| 15 | Deployment configuration and documentation | ✅ | `render.yaml`, `deploy/`, `docs/DEPLOYMENT.md` |
| 16 | CI on GitHub (last pushed commit) | ✅ | Actions run 41295362323 |

## 2. Requirement verification (highlights)

| Area | Verified by |
|---|---|
| Independent timers, never shared (R1/R2) | Stream checks (nobody receives another user's `session_state`), type-level event map, audit H, two rooms × four users |
| Breaks 5/10/15/30 only, never counted, no early or automatic resume | Zod literal, machine table, DB constraints, summaries, E2E-2/E2E-3, notification E2E (phase stays Break Over) |
| One active session per user | Unique index, advisory lock + row lock, CT-1 (20 parallel starts), E2E-6 |
| 2-minute grace (solo vs room liveness), 30-minute idle, restart safety | RT-4a/RT-4b, RT-8, CT-4, INT-RESILIENCE (crash + restart), P5–P7 |
| Rooms: codes, join, 50 members, permanent membership, moves without reset, room tasks | INT-ROOMS, CT-10/CT-11, RT-7, RT-10, E2E-4/5/7/8/12 |
| Timezones and history | §6.1 DST matrix, SQL ↔ Intl cross-check (300 random cases), non-UTC DB session, D-6 snapshot, E2E-11 |
| Streak (≥ 25 min per local day, from history) | INT-STATS streak tests (24:59 doesn't count, 15 + 10 does, at-risk, gaps) |

## 3. Gaps found in the requirements review

| Item | Approved in | Status |
|---|---|---|
| Password reset (D-4) | Roadmap 5.1 — required before release | **Missing — critical** |
| Account deletion (D-4) | Roadmap 5.2 — required before release | **Missing — critical** |
| Room history page (`GET /rooms/:id/history`) | F-41/F-48, roadmap 4.2 | Missing (not critical for core use) |
| Sound with the break-end notification | F-48, roadmap 4.3 | Missing (the notification itself works) |
| Daily chart with 7/30/90-day ranges | Roadmap 3.3 | Partial: last-14-days bars, weekly/monthly charts, heatmap |

These were **not** built here because this stage excluded new features. Each needs your decision.

## 4. Remaining blockers

| # | Blocker | Severity | What closes it |
|---|---|---|---|
| 1 | D-4 password reset and account deletion | **Critical** (roadmap release criterion) | Implement them (needs an email provider), or explicitly accept launching without them |
| 2 | Real deployment not verified | **Critical** | Deploy per `docs/DEPLOYMENT.md` and pass §7 (smoke on Vercel and on Render, two-browser check, rate-limit check). Unverified points: Vercel rewrites with long-polling, `TRUST_PROXY=2`, Neon `btree_gist`, Render pre-deploy |
| 3 | 3 high `npm audit` advisories in the Prisma **CLI** config loader (`deepmerge-ts`) | Low (build time only, no user input reaches it) | Upgrade to Prisma 7 (major) |
| 4 | Single instance; no retention job; no email verification | Low for an MVP | Documented in the deployment guide |

## 5. Security review

| Area | Result |
|---|---|
| Authentication | bcrypt 12; 10–72-byte passwords; 15-minute HS256 access token in memory only (never in web storage — E2E-checked); hashed, rotating refresh tokens with family revocation; CSRF header; uniform login errors; rate limits |
| Authorization | Enforced in services; table-driven SEC-1 over every REST endpoint (anonymous / forged → 401, non-members → identical 404, owner-only sessions); sockets: membership for rooms and room tasks, task delete rights, `auth_renew` bound to the same user |
| Database access | Parameterized tagged-template SQL only (the `Unsafe` APIs are lint-banned); hand-written constraints as the last line of defense (INT-SCHEMA); all instants from the server clock; results independent of the session timezone |
| Input validation | Zod `.strict()` on every boundary; 100 KB bodies (413), 64 KB socket messages; stored XSS rendered as text (E2E); `?next=` after login only accepts in-app paths (unit-tested) |
| Transport and config | HSTS and CSP in production; Secure, HttpOnly, SameSite=Strict cookie on `/api/v1/auth`; production refuses insecure settings and a stray `.env`; no secrets in the repository |

## 6. Failed or partial checks

| Check | Outcome | Why it isn't a code defect |
|---|---|---|
| Smoke through the local Vercel stand-in: CSP header | Missing | The stand-in sends no headers; on Vercel they come from `vercel.json` (unverified until deployed) |
| Smoke through the stand-in: WebSocket | Refused | By design: Vercel rewrites can't carry WebSockets; the app stays on long-polling (verified working) |
| `npm audit` (all dependencies) | 3 high (Prisma CLI), 11 moderate (ESLint tooling) | Build or dev time only; 0 advisories in runtime dependencies after the zod upgrade |

## 7. Bugs fixed in this stage

| Bug | Fix |
|---|---|
| An invite link opened while logged out lost the invitation after login or signup | `?next=` is preserved through login and register (safe in-app paths only) |
| The room screen said "not a member" for every join error, including "your session lives in another room" | It shows the real reason; the not-found text only for NOT_FOUND |
| The smoke test couldn't check a backend that doesn't serve the web app | `--api-only` mode |
| Deployment config assumed Render served the web app | Render is API-only by default (`TRUST_PROXY=2`); Vercel builds from the repository root |
