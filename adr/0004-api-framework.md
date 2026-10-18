# ADR-0004: NestJS + Fastify for the API

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

The API needs a structured, testable framework with first-class TypeScript
support, dependency injection for clean domain/application/infrastructure
separation, and good throughput for a mobile client making frequent sync
requests.

## Decision

Use NestJS on the mature 11.1.x/11.2.x line with the Fastify adapter
(`@nestjs/platform-fastify`), not the default Express adapter, and not
NestJS 12.

## Alternatives considered

- **NestJS 12 (latest major)**: rejected for now — spec section 12
  explicitly requires architecture review before adopting a new major;
  11.2.x is the current mature, widely-deployed line with no known blocker
  for this bootstrap's needs.
- **Express adapter**: rejected in favor of Fastify's materially better
  throughput/latency profile, relevant given frequent mobile sync calls.
- **Hand-rolled Fastify (no Nest)**: rejected — would lose Nest's DI/module
  system, which is what makes the domain/application/auth/sync/persistence
  boundaries enforceable in code, not just in documentation.

## Consequences

- Fastify-specific request/reply types leak into a few boundary points
  (middleware, exception filter) — isolated to `apps/api/src/common`.
- Revisiting NestJS 12 is a future, separate ADR once the ecosystem
  (platform-fastify, swagger, config packages) has matured on that line.
