# StudySync

A study platform where students track tasks, run their own study timer with controlled
breaks, and build streaks — solo, or together in shared rooms where everyone sees each other's
status but studies at their own pace.

> *Your study time is always yours. Rooms give presence and shared tasks — never a shared timer.*

> **Status:** Architecture v1.1 approved (with clarifications). Implementation starts with
> the Phase 0 spike after the product owner's explicit go.

## Documentation

| Document | Contents |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | Working rules, non-negotiable product rules, conventions, cloud dev environment |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Spec coverage, product decisions, membership vs presence vs session, solo vs room liveness, timer state machine, timezones, security, risks, folder structure |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | Prisma schema, DB constraints, key queries, invariants |
| [API_DESIGN.md](./API_DESIGN.md) | REST endpoints and Socket.IO events |
| [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md) | Phases, acceptance criteria, milestones |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) | Test layers, timezone/DST matrix, concurrency tests, traceability matrix |

## Stack

React · TypeScript · Vite · Tailwind CSS · Recharts · Node.js · Express · PostgreSQL · Prisma ·
Socket.IO · JWT · bcrypt · Zod
