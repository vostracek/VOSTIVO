# ADR-0005: PostgreSQL + Drizzle ORM

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

Vostivo's server persistence model is relational current-state plus
durable history (explicitly not event sourcing — spec section 34), backed
by Supabase-hosted PostgreSQL. The team wants type-safe queries and
explicit, reviewable SQL migrations rather than a magic/implicit schema
sync.

## Decision

Use Drizzle ORM 0.45.2 (stable) with `drizzle-kit` for migration
generation, against PostgreSQL. No physical product schema is created yet;
`packages/database` only establishes the schema-source/migration-output/
migration-script infrastructure (spec sections 16-17).

## Alternatives considered

- **Drizzle 1.0 RC**: rejected — spec section 2 explicitly forbids
  adopting a release-candidate ORM version for a foundation other code
  will be built on.
- **Prisma**: rejected — Drizzle's SQL-shaped query builder and lighter
  runtime footprint fit a mobile-sync-heavy backend better, and avoids
  Prisma's separate codegen/engine binary.
- **Raw SQL / query builder (Kysely, knex)**: rejected — Drizzle gives
  equivalent SQL transparency plus a maintained migration-generation tool,
  without hand-writing migration SQL from scratch.

## Consequences

- `pnpm db:generate` / `pnpm db:migrate` become the only sanctioned way to
  change the server schema — no manual `ALTER TABLE` against a live DB.
- Local development requires a running Postgres (`docker-compose.yml` at
  the repo root); core unit tests must never require a live DB connection
  (spec section 16) — enforced by keeping `packages/database`'s tests
  schema/config-only.
