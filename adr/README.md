# Architecture Decision Records

This directory records architecture decisions for Vostivo: what was decided,
what alternatives were considered, and why. Write one ADR only when a real
decision is being made or instantiated — not speculatively.

## Process

1. Copy `TEMPLATE.md` to `NNNN-short-title.md` (next sequential number).
2. Fill in Context, Decision, Alternatives considered, Consequences.
3. Set `Status` to `Proposed` while under discussion, `Accepted` once decided.
4. If a later decision reverses an earlier one, mark the old ADR
   `Superseded by ADR-NNNN` rather than deleting it — history stays legible.

## Index

| ADR                                 | Title                    | Status   |
| ----------------------------------- | ------------------------ | -------- |
| [0001](./0001-monorepo.md)          | Monorepo with pnpm+Turbo | Accepted |
| [0002](./0002-expo-react-native.md) | Expo + React Native      | Accepted |
| [0003](./0003-modular-monolith.md)  | Modular monolith         | Accepted |
| [0004](./0004-api-framework.md)     | NestJS + Fastify         | Accepted |
| [0005](./0005-database-orm.md)      | PostgreSQL + Drizzle ORM | Accepted |
| [0006](./0006-uuidv7-domain-ids.md) | UUIDv7 domain IDs        | Accepted |
| [0007](./0007-workout-sync-protocol.md) | Workout offline sync protocol | Accepted |
| [0008](./0008-plan-program-hierarchy.md) | Plan/Program hierarchy | Accepted |
| [0009](./0009-progression-application-architecture.md) | Progression Application overlay architecture | Accepted |
| [0010](./0010-loading-capability-architecture.md) | Loading Capability architecture | Accepted |
