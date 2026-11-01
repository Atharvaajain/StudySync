# StudySync — MVP Finalization: Test Report

|             |                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch      | `feature/phase-3-finalization` (from Phase 2, `8564e56`)                                                                                                     |
| Date        | 2026-11-01                                                                                                                                                   |
| Environment | Claude Code cloud container · Node 22 · PostgreSQL 16 · Chromium (Playwright 1.63.0)                                                                        |
| Verdict     | **All automated checks pass** (302 Vitest + 25 E2E), and a **local production-mode rehearsal** passed 13/13 smoke checks. **Not deployed** — see §7 for release blockers. |

The request's "Phase 3: Finalization" covers roadmap Phase 3 (period charts), Phase 4 (heatmap,
break notification, UX pass) and the release-hardening parts of Phase 5 (security review,
production configuration, deployment preparation). The two Phase 5 account features (D-4) were
**not** built — they are new features, which this request excluded.

---

## 1. Results

| Suite | Files | Tests | Result |
|---|---:|---:|---|
| Timer core (user table, system table, focused, properties P1–P9) + shared contract | 5 | 183 | ✅ |
| Web unit (version guard, task order, break-notification decision) | 1 | 5 | ✅ |
| Server unit (queue, scheduler, rate limiter, environment incl. production rules) | 1 | 11 | ✅ |
| PostgreSQL integration: schema, auth, rooms, stats, **timezone (new)**, **SEC-1 matrix (new)** | 6 | 52 | ✅ |
| Realtime (real server + sockets): Phase 0, solo, rooms, liveness/restart, **multi-room (new)** | 5 | 51 | ✅ |
| **Total Vitest** | **18** | **302** | ✅ **302 / 302** |
| E2E Playwright: Phase 0 (8) · Phase 1 (6) · Phase 2 (7) · **Phase 3 (4, new)** | 4 | 25 | ✅ **25 / 25** |
| Production rehearsal (`NODE_ENV=production`, bundled server + built web) — `npm run smoke` | — | 13 | ✅ 13 / 13 |
| Invariant audit (DATABASE_DESIGN §8) on the test and rehearsal databases | — | 8 queries | ✅ no violations |
| Typecheck (4 workspaces) · ESLint · Prettier | — | — | ✅ clean |

Every DB-backed test ends with the §8 audit returning no rows. The SQL ↔ Intl cross-check also
passed with 300 random cases (`TZ_RUNS=300`).

## 2. Tasks → evidence

| # | Task | What was done | Evidence |
|---|---|---|---|
| 1 | Responsive UI | Header and forms wrap; timer text scales; task form stacks; tested at 360 px | E2E "mobile (360 px)": no horizontal scroll on dashboard, room, history, settings; screenshots 02–04 |
| 2 | Weekly / monthly charts | `GET /stats/periods` (ISO weeks / months from the per-day split) + stacked Solo/Rooms bars with legend, titles and a table view | INT period test (sums = daily, zero-fill, qualified days, 400 on bad input); E2E: weekly sum = daily sum |
| 3 | Activity heatmap | `GET /stats/heatmap` (§6.11, each segment's own zone) + 7 × 24 grid | Heatmap conserves total time, local weekday/hour across fall-back; E2E: heatmap sum = daily sum |
| 4 | Loading and error states | Error boundary, offline / connection banner, spinners, "Try again", room not-found state | E2E unknown room → clear message; manual review |
| 5 | Break-end notification | Permission from the break click; once per break; only when the tab is hidden; click focuses the app; **never resumes** | Unit tests (decision); E2E: one notification, phase stays `BREAK_OVER` |
| 6 | Bug fixes | See §5 | Regression tests where applicable |
| 7 | Authentication and authorization | SEC-1 table over every REST endpoint (anonymous, garbage and forged tokens → 401; non-members → identical 404 for existing and missing rooms; owner-only sessions); existing JWT, refresh-reuse, CSRF, rate-limit suites | `security.test.ts`, `auth.test.ts`, realtime SEC-2 tests |
| 8 | Multiple users and rooms | Two rooms × four users: statuses and room tasks never cross rooms, nobody gets anybody else's `session_state`, non-members can't enter | `phase3.multiroom.test.ts`; Phase 2 three-browser E2E |
| 9 | Timer and timezone handling | SQL ↔ Intl day-split cross-check over 8 DST-heavy zones; a non-UTC database session gives identical daily totals, heatmap and streak; DST matrix; snapshot rule (D-6) | `timezone.test.ts` (+ existing `stats.test.ts`, system/machine tables P5–P7) |
| 10 | Database security and constraints | See §4 | INT-SCHEMA, §8 audit, `npm run db:audit` |
| 11 | Production environment variables | `deploy/production.env.example`; the server refuses insecure production config | Env unit tests; rehearsal |
| 12 | Deployment instructions | `docs/DEPLOYMENT.md`, `render.yaml`, `deploy/vercel.example.json`, `npm run smoke` | Rehearsed locally only |
| 13 | README and documentation | README, CLAUDE.md status, this report, deployment guide | — |

## 3. Production rehearsal (local, not a deployment)

Built with `npm run build`, started with `node apps/server/dist/index.js`, `NODE_ENV=production`,
a fresh database (`prisma migrate deploy`), **default** security settings:

- `npm run smoke` 13/13: health + DB readiness, web app + SPA fallback, CSP, registration,
  refresh cookie `HttpOnly; Secure; SameSite=Strict`, rotation, authenticated read, Socket.IO
  over long-polling **and** WebSocket, start → end study with summary.
- `Strict-Transport-Security` and `upgrade-insecure-requests` are sent in production.
- `TRUST_PROXY=1`: the 6th registration from one client IP → 429, another IP → 201.
- A real browser on the production build stayed signed in across a reload (Secure cookie), with
  the timer still running and the socket connected.
- The server refuses to start when: `COOKIE_SECURE=false`, `BCRYPT_COST < 12`, an example JWT
  secret, any test switch, or a stray `apps/server/.env` (see §5).

## 4. Security review

| Area | Finding |
|---|---|
| Authentication | bcrypt 12, 10–72 byte passwords; 15-min HS256 access token in memory only; hashed rotating refresh tokens with family revocation; CSRF header on cookie endpoints; uniform login errors |
| Authorization | Enforced in services; foreign resources → 404 with identical bodies (no existence leak); room tasks: members only, delete by task or room creator; no endpoint or event controls another user's timer |
| Input | Zod `.strict()` everywhere; body limit 100 KB (→ 413); socket messages 64 KB; stored XSS rendered as text (E2E SEC-8) |
| Database | Hand-written constraints (one active session, 5/10/15/30 breaks, no overlap, no system resume, room code format) verified by INT-SCHEMA; only parameterized SQL (lint bans the `Unsafe` APIs); all instants from the app clock; timezone-independent queries |
| Transport | HSTS + CSP in production; SameSite=Strict cookie scoped to `/api/v1/auth`; one origin |
| Rate limits | Login, register, refresh, join-by-code, reads, sockets; proxy-aware with `TRUST_PROXY` |
| Dependencies | `npm audit`: **0 runtime advisories** after upgrading zod 4.3.3 → 4.6.7 (memory exhaustion on oversized collections). Remaining: 3 high in the Prisma **CLI** config loader (`deepmerge-ts`, build time only, fix needs Prisma 7 — accepted for now) and 11 moderate in ESLint tooling (dev only) |
| Secrets | No credentials in the repository (scan of tracked files); dev placeholders are refused in production |

Recommended before launch: a separate least-privilege database role for the app; Neon
point-in-time restore; a nightly `npm run db:audit`.

## 5. Bugs found and fixed

| Bug | Impact | Fix |
|---|---|---|
| Rate limits keyed by the proxy's IP behind Render/Vercel | Every user would share one login/register bucket | `TRUST_PROXY` setting |
| Socket transport was WebSocket-first | No connection behind proxies without WebSockets (Vercel rewrites) | Polling first, then upgrade (Socket.IO default); polling covered by a test |
| Production refused outright / no production hardening | Couldn't be deployed safely | Production allowed only with a secure configuration; HSTS |
| Prisma auto-loads `apps/server/.env` at import | A stray file could silently override production settings | Server refuses to start in production if that file exists; `.env` is never read in production |
| Opening a room you're not a member of showed a stuck "Joining…" | Confusing dead end | Clear "doesn't exist or you're not a member" state |
| Task form overflowed on narrow screens | Horizontal scrolling on phones | Wrapping layout (360 px test) |
| zod advisory (memory exhaustion) | Request validation hardening | zod 4.6.7 |

## 6. Deviations from the approved documents (for your decision)

- Charts are plain HTML/CSS bars instead of Recharts (ARCHITECTURE §8.2) — no new dependency,
  with a legend, hover titles and a table view; colors validated for color-vision deficiency.
- Production is now allowed (previously refused until Phase 5) behind strict configuration checks.
- Option B in the deployment guide (Vercel web + Render API) keeps one origin through rewrites,
  but realtime then runs on HTTP long-polling.
- The break notification has no sound (roadmap 4.3 mentions one).
- Room history page (roadmap 4.2) was not built.

## 7. Release status — not yet ready for a public launch

1. **Password reset and account deletion (D-4)** are not implemented. The roadmap requires them
   before release.
2. **Not deployed.** Neon / Render / Vercel steps are prepared and rehearsed locally only; the
   first real deployment must pass `npm run smoke` and a two-browser manual check.
3. Single instance only; no retention job for `session_events` / `refresh_tokens`; no email
   verification.

Screenshots: [history charts](./screenshots/01-history-charts.png) ·
[mobile dashboard](./screenshots/02-mobile-dashboard.png) ·
[mobile room](./screenshots/03-mobile-room.png) ·
[mobile settings](./screenshots/04-mobile-settings.png)
