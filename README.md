# StudySync

A study platform where students track tasks, run their own study timer with controlled
breaks, and build streaks — solo, or together in shared rooms where everyone sees each other's
status but studies at their own pace.

> *Your study time is always yours. Rooms give presence and shared tasks — never a shared timer.*

> **Status:** Design v1.0 final (reconciled with the final spec), awaiting approval.
> Implementation starts with the Phase 0 spike after approval.

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
