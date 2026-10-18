# ADR-0003: Modular monolith API (not microservices)

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

Vostivo's server side has clear internal boundaries (domain, application,
auth, sync, persistence) but a small team and, initially, low operational
scale. Microservices would add deployment/versioning/network overhead
without a corresponding scaling or team-topology need.

## Decision

Build `apps/api` as a single NestJS modular monolith with enforced internal
module boundaries (via package/module structure and the dependency-cruiser
boundary check), plus a separate `apps/worker` process for async work.
`apps/worker` is a separate execution process, not a separate
business-domain microservice.

## Alternatives considered

- **Microservices per domain area**: rejected — see spec section 35;
  premature given team size and current scale, and would fragment the
  transactional guarantees the Training Engine and sync protocol need.
- **Single process for API + worker**: rejected — async/background jobs
  (engine evaluation, notifications) should not compete with request-serving
  latency or share a crash domain with the HTTP API.

## Consequences

- Module boundaries must be enforced by tooling (dependency-cruiser), not
  just convention, or the monolith drifts into a "big ball of mud."
- Scaling the API and worker independently is still possible (they are
  already separate processes/deployables) without a rewrite.
