# StudySync

A real-time collaborative study application: study in reusable rooms alongside others, each
with your **own independent timer**, share a live task list, and track daily study time,
streaks and analytics.

> **Status:** Phase 0 — planning. Design documents only; implementation starts after approval.

## Documentation

| Document | Contents |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | Working rules, non-negotiable product rules, conventions, cloud dev environment |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Requirements analysis, open questions, system design, timer state machine, risk registers, folder structure |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | Prisma schema, DB constraints, key queries, invariants |
| [API_DESIGN.md](./API_DESIGN.md) | REST endpoints and Socket.IO events |
| [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) | Phases, acceptance criteria, milestones |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) | Test layers, timezone/DST matrix, concurrency tests, traceability matrix |

## Stack

React · TypeScript · Vite · Tailwind CSS · Recharts · Node.js · Express · PostgreSQL · Prisma ·
Socket.IO · JWT · bcrypt · Zod
