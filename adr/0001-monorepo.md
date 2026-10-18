# ADR-0001: Monorepo with pnpm workspaces + Turborepo

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

Vostivo consists of four deployable units (mobile, web, api, worker) that
share a domain model, a deterministic training engine, transport contracts,
and cross-cutting infrastructure (config, observability, database). These
must stay in lockstep — e.g. a contract change in `packages/contracts`
should be a single atomic commit visible to every consumer, not a
cross-repo version-bump dance.

## Decision

Use a single pnpm-workspace monorepo (`apps/*`, `packages/*`) orchestrated
by Turborepo for task graphs (build/lint/typecheck/test), with pnpm as the
sole package manager and lockfile.

## Alternatives considered

- **Polyrepo per app**: rejected — would require publishing/versioning
  internal packages (domain, training-engine, contracts) just to share them
  across apps, adding release overhead with no benefit at this stage.
- **npm/yarn workspaces**: rejected in favor of pnpm's stricter
  node_modules layout (catches implicit/undeclared dependencies) and
  faster installs via its content-addressable store.
- **Nx**: rejected — Turborepo's task-graph model is sufficient for this
  repo's needs; Nx's generators/plugin ecosystem would be unused surface
  area (spec section 33: no premature abstraction).

## Consequences

- One lockfile, one CI pipeline, one version of TypeScript/ESLint/Prettier
  to keep in sync across the whole repo.
- Native mobile tooling (Expo/React Native autolinking) needs pnpm's
  `node-linker=hoisted` — documented in `.npmrc` and
  `docs/architecture/FOUNDATION.md`.
- Turborepo's caching only helps once task outputs are deterministic;
  tasks with side effects (e.g. `db:migrate`) are intentionally excluded
  from cached pipelines.
