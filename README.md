# Vostivo

Vostivo is a mobile-first strength/hypertrophy training system: offline-first
Active Workout, a deterministic Training Engine, planned training kept
separate from performed reality, and server-canonical synchronized history.

This repository is currently at **Foundation Bootstrap** — the monorepo
scaffolding, tooling, and architectural boundaries future vertical slices
build on. No product features are implemented yet. See
`docs/architecture/FOUNDATION.md` for what exists and why, and `adr/` for
the architecture decisions behind it.

## Monorepo layout

```text
apps/
  mobile/     Expo (React Native) — offline-first athlete client
  web/        Next.js — public marketing site + future coach app
  api/        NestJS + Fastify — modular monolith API
  worker/     Node process — async jobs / future Training Intelligence

packages/
  domain/            pure TS domain primitives (framework-free)
  training-engine/   deterministic decision engine boundary (framework-free)
  contracts/         transport-neutral shared contract vocabulary
  database/          PostgreSQL/Drizzle migration infrastructure
  config/            typed, fail-fast environment validation
  observability/     vendor-agnostic logging + correlation ids
  test-fixtures/     shared deterministic test fixtures

docs/       architecture + development documentation
adr/        architecture decision records
```

## Prerequisites

- Node.js 24.20.x LTS
- pnpm 11.25.0 (`corepack enable && corepack prepare pnpm@11.25.0 --activate`)
- Docker (optional, for local Postgres)

Full setup instructions: [`docs/development/SETUP.md`](./docs/development/SETUP.md).

## Install

```bash
pnpm install --frozen-lockfile
```

## Common commands

```bash
pnpm dev          # run all apps in dev mode (Turborepo)
pnpm build        # build everything
pnpm lint         # lint everything
pnpm typecheck    # typecheck everything
pnpm test         # run all unit tests
pnpm format       # format with Prettier
pnpm db:generate  # generate a Drizzle migration from packages/database schema
pnpm db:migrate   # apply pending migrations
pnpm boundaries:check  # enforce architectural dependency rules
```

## Architecture at a glance

Modular monolith API (not microservices), pure/framework-free domain and
Training Engine packages, relational current-state + durable history
(not event sourcing). See `docs/architecture/FOUNDATION.md` for the full
picture and enforced dependency-direction rules.

## Contributing

Read [`CLAUDE.md`](./CLAUDE.md) before making architectural changes — it
defines what an implementation session must never silently change.
