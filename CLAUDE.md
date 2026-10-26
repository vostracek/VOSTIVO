# CLAUDE.md — Vostivo

This file is the central living project compass for every Claude Code
session working in this repository — not just an instruction file. Read it
before making any non-trivial change, and keep it current (see
"Maintenance rule" at the end).

## Product

Vostivo is a mobile-first strength/hypertrophy training system. Its core
promise: **training that keeps pace with you** — the plan adapts to real
life (missed sessions, fatigue, available equipment, time) without losing
long-term direction.

- **Target V1 user**: an intermediate-to-advanced strength/hypertrophy
  athlete who already knows how to train, wants a plan that stays coherent
  when life gets in the way, and wants their training history to actually
  mean something (not just a workout logger).
- **V1 scope**: strength/hypertrophy training only. Not a general fitness
  tracker, not a CrossFit/conditioning system, not a nutrition app.
- **Core principle**: _smallest necessary change without losing long-term
  direction_ — when reality diverges from the plan, Vostivo makes the
  minimal adjustment that keeps the athlete on track, rather than either
  ignoring the divergence or throwing out the plan.
- **Vostivo is explicitly NOT**:
  - a generic workout logger with no opinion about progression,
  - an analytics dashboard the athlete has to interpret themselves,
  - a rigid fixed program that ignores what actually happened,
  - a social/community fitness app.

## Product strategy

High-level tiering only — **no specific price points are decided**; don't
invent numbers.

- **Free**: logging and plan execution remain fully usable on their own.
  Logging is never gated behind intelligence features — an athlete who
  never touches adaptive features still gets a complete, trustworthy
  training log.
- **Pro**: adaptive intelligence (Training Engine decisions, richer
  Progress insight) layered on top of the same logging core.
- **Coaching**: adds the coach-facing surfaces (Coach Attention on web,
  coach/athlete relationship, private coach notes).
- Vostivo is a **decision/action product, not an analytics dashboard** — it
  tells the athlete (and coach) what to do next and why, rather than
  presenting raw charts and leaving interpretation to them.

## UX architecture (high-level — see detailed specs for the rest)

```text
Today      — what to do right now
Plan       — the training plan, and how it's adapting
Progress   — trend/history, in service of decisions, not raw analytics
Profile    — athlete settings/identity
Active Workout — standalone mode: the actual in-gym logging experience
Coach Attention (web) — coach-facing surface, not a mirror of the athlete app
```

This repo does not duplicate the detailed UX/product specification —
reference it rather than re-deriving screen behavior from memory here.

## Technical architecture

```text
pnpm + Turborepo monorepo

apps/mobile   Expo (React Native), athlete app
apps/web      Next.js, public site + Coach Attention
apps/api      NestJS + Fastify, modular monolith
apps/worker   Node process, async jobs / future Training Intelligence

PostgreSQL + Drizzle           server-canonical current state + durable history
local SQLite + Drizzle         on-device, SQLCipher-encrypted (apps/mobile)
SQLCipher + expo-secure-store  local DB encryption; key lives in SecureStore, never the DB itself
Supabase Auth                  identity provider ONLY (Data API disabled) — email + 6-digit
                                OTP sign-in, SecureStore-chunked session, JWKS verification
                                (Auth Slice C; human acceptance PASSED 2026-10-26)
domain-aware outbox/cursor sync mobile <-> API (protocol not yet implemented)
pure deterministic Training Engine  packages/training-engine — no framework/infra dependency
```

Style: **modular monolith**, not microservices. `apps/worker` is a separate
_process_, not a separate business-domain service.

Full topology, dependency directions, and the enforced boundary mechanism:
`docs/architecture/FOUNDATION.md`. SQLCipher/key-management details live
there too. Identity/auth boundary (JWT verification, `User`/`AuthIdentity`/
`AthleteProfile`, `AuthenticatedActor`): `docs/architecture/IDENTITY-AUTH.md`.

## Core architecture principles

These are load-bearing and must not be silently violated by any
implementation choice:

- **Plan != performed reality.** What was planned and what actually
  happened are distinct and both retained — the plan does not get rewritten
  to match what happened.
- **Active Workout is local-first.** Network is not required to complete a
  set. Local state must be fully usable offline.
- **Local state + outbox must eventually be atomic** — a set logged offline
  either fully reaches the server's canonical history, or the local
  outbox still shows it pending; there is no state where it silently
  vanishes or is silently only half-applied.
- **Historical reality is not rewritten by future plan changes.** Changing
  next week's plan must never alter what the log says happened last week.
- **The Training Engine is deterministic**: same input + same
  engine/policy version = same output, always. A logic/policy change that
  could alter output for existing input requires a version bump, not an
  in-place mutation.
- **Generic last-write-wins is forbidden for workout-history conflicts.**
  Training history is server-canonical with an explicit, domain-aware
  conflict resolution — not "whoever synced last wins."
- **Authentication != authorization.** Being logged in as _someone_ is not
  the same as being allowed to see/do a specific thing (e.g. a coach
  viewing an athlete's data).
- **Subscription != entitlement.** Having an active subscription tier is
  not itself the authorization check — entitlement is evaluated
  explicitly, not inferred from billing state at the point of use.
- **Private coach notes are structurally protected** — not just
  UI-hidden. The data boundary must hold even if a client is compromised
  or a new surface is added carelessly.
- **Sensitive free text does not flow to analytics/logs.** Athlete/coach
  free-text fields are not something structured logging or an analytics
  vendor ever sees.

## Locked decisions

See `adr/` for full reasoning. Summary:

- Monorepo: pnpm workspaces + Turborepo (ADR-0001).
- Mobile: Expo + React Native, development-build-oriented, not Expo
  Go-only (ADR-0002) — required because the app now uses SQLCipher, which
  Expo Go cannot load.
- Server: modular monolith, not microservices (ADR-0003).
- API framework: NestJS 11.x + Fastify, not NestJS 12 (ADR-0004).
- Database: PostgreSQL + Drizzle ORM 0.45.2 stable, not a 1.0 RC
  (ADR-0005).
- Local DB encryption: `expo-sqlite`'s built-in SQLCipher support
  (`useSQLCipher: true`), not a third-party SQLite/SQLCipher library —
  see `docs/architecture/FOUNDATION.md`.
- Load Model V1: a load is always **value + unit + kind + basis + loading
  profile**, never a bare number; canonical weight values are
  fixed-precision scaled integers (`amountMilli`, scale 1000), never
  floats; historical equipment units and semantics are never rewritten.
  Full spec and the 20 locked `LOAD-INV-*` invariants:
  `docs/domain/load-model-v1.md`.
- Domain IDs: UUIDv7 via the `uuidv7` package's RNG-injectable
  `V7Generator`, centralized behind `createEntityId()` — never UUIDv4,
  never auto-increment, never `Math.random()`, never a global
  `crypto.getRandomValues` polyfill. Server/web auto-detect native Web
  Crypto; mobile explicitly configures an `expo-crypto`-backed source at
  startup. Verified on a real Android emulator with network disabled
  (ADR-0006, `docs/architecture/IDENTITY-AUTH.md`).
- JWT verification: `jose` + Supabase's per-project JWKS endpoint
  (asymmetric, no shared secret held by the API) — not the legacy
  HS256/shared-secret verification path. See
  `docs/architecture/IDENTITY-AUTH.md`.
- Identity is `(provider, providerSubject)` via `AuthIdentity`, never
  email. `User` stays general account identity, not permanently
  athlete-only. Persisted `experienceMode` excludes `COACHED` — coached
  experience is derived from a future `CoachingRelationship`, never
  stored as a base mode.

## Implementation role

Claude Code acts as **implementation engineer** on Vostivo. Product, UX,
domain, architecture, security, privacy, sync, and QA design are decided
elsewhere — implementation sessions execute against those decisions.

Claude Code **may**:

```text
implement approved architecture
write tests
identify conflicts
propose ADRs
refactor within approved boundaries
```

Claude Code must **NOT silently**:

```text
change product scope
change UX hierarchy
change Training Engine methodology
weaken offline guarantees
weaken authorization/security
change core stack
introduce new vendors
introduce new tracking
add new V1 features
```

### Mandatory principle

If an implementation task conflicts with an approved architectural or
product decision (an ADR, a hard constraint above, or anything in this
file):

```text
STOP
REPORT the conflict explicitly to the user
PROPOSE an ADR (or a change to an existing decision)
```

Do not silently work around it, and do not pick "the least bad option" and
proceed as if it were approved.

## Working conventions

- **No premature abstraction**: no generic repository framework, generic
  event bus, custom ORM/DI system, universal CRUD service, or CQRS
  framework. Build the boundary the current slice needs.
- **No event sourcing** and **no microservices** — relational current
  state + durable history + domain events where useful.
- **TypeScript strict stays strict** — do not weaken `tsconfig.base.json`
  to silence an error; fix the error, or scope an exception narrowly to
  the one file that needs it.
- **Never commit secrets** — `.env` is gitignored; only `.env.example`
  (placeholder values) is committed. Production credentials are never
  required for `pnpm test` to pass.
- **Physical DB schema grows per vertical slice** — do not add product
  tables to `packages/database` speculatively.
- **Vitest** is the test runner across the repo; do not introduce Jest
  alongside it without a documented reason.
- **ESLint is intentionally split** (ESLint 10 root/backend, ESLint 9 for
  `apps/web`/`apps/mobile`) — this is documented, temporary technical debt
  caused by upstream plugin lag, not an oversight. See
  `docs/architecture/FOUNDATION.md`. Don't force-upgrade the app configs
  just for consistency; don't let a third ESLint major creep in either.

## Current project state

```text
Foundation Bootstrap:            APPROVED
Load Model V1:                   SPECIFIED
SQLCipher native runtime gate:   PASSED
Auth/Internal Identity Foundation: IMPLEMENTED
Mobile UUIDv7 runtime gate:       PASSED
Workout Data Integrity Vertical Slice: APPROVED
Post-WDI Tooling Fix Pass:       APPROVED
Plan & Workout Prescription Vertical Slice: APPROVED
Plan Contract Integrity Fix Pass: APPROVED
Active Workout Core Logger V1:   APPROVED (final review pass complete)
Active Workout Finish Causal Boundary Fix: IMPLEMENTED (sessionSeq/finishSeq
                                  causal gate live in mobile repository +
                                  API command processing)
Active Workout UX bug-fix pass:  APPROVED (input editing, scroll, stuck
                                  Starting state, back navigation)
Active Workout Claude Design Alignment Pass: APPROVED — functionally and
                                  visually approved by tech lead.
V1 Engineering, Security & Performance Baseline Audit: COMPLETE — see
                                  docs/audits/V1-ENGINEERING-SECURITY-BASELINE.md.
                                  Verdict: YES, WITH MATERIAL GAPS.
Security Hardening Follow-Up V1: COMPLETE — all three P1-before-beta
                                  decisions the audit left open are now
                                  LOCKED and implemented:
                                  (1) Postgres least privilege — a new
                                  `vostivo_api` runtime role (no DDL, no
                                  role creation) is bootstrapped by
                                  `pnpm db:bootstrap-roles`
                                  (packages/database/src/bootstrap-roles.ts);
                                  `DATABASE_URL` is now the runtime role,
                                  `MIGRATION_DATABASE_URL` the admin role
                                  that owns the schema and runs migrations.
                                  Proven with real PostgreSQL permission
                                  denials (SQLSTATE 42501), not grant
                                  inspection.
                                  (2) API rate limiting — `@fastify/
                                  rate-limit` registered globally
                                  (apps/api/src/common/rate-limit.ts),
                                  env-configurable (`RATE_LIMIT_MAX`
                                  default 300/min), in-memory/per-instance
                                  only (no Redis) — horizontal scaling
                                  needs a shared store or ingress-level
                                  limiting later, documented at the
                                  registration site. `TRUST_PROXY`
                                  defaults false.
                                  (3) Android backup — tech lead chose
                                  "disable entirely":
                                  `apps/mobile/app.json`'s
                                  `android.allowBackup: false`, verified
                                  against the real generated
                                  AndroidManifest. Rationale/recovery
                                  model in docs/architecture/FOUNDATION.md.
                                  Also investigated: the `fastify` CVEs
                                  remain unresolved (still no compatible
                                  `@nestjs/platform-fastify` release — an
                                  exact version pin, not a range) but are
                                  now confirmed NOT REACHABLE in Vostivo's
                                  actual config (no Fastify-native schema
                                  validation in use; TRUST_PROXY is
                                  boolean-only, never the vulnerable
                                  numeric hop-count form) — downgraded
                                  from a beta blocker to a tracked/
                                  monitored item. Still open, not silently
                                  resolved: placeholder Android package id
                                  (`com.anonymous.vostivo`), zero real iOS
                                  native verification.
Native Android Sync Recovery Re-Verification: COMPLETE (2026-09-09) — the
                                  AUD-041 SYNCING-outbox fix is now
                                  NATIVE ANDROID VERIFIED: proven on a
                                  real emulator with a real process kill
                                  (`adb shell am force-stop`) mid-sync, a
                                  real lost-ACK (server never received the
                                  request at all), successful recovery on
                                  the next sync attempt (same commandId,
                                  attempts incremented, zero duplicate
                                  domain data), and a live Finish
                                  causal-boundary smoke check (a genuine
                                  post-Finish mutation crafted against the
                                  real API was REJECTED with zero state
                                  change). No source code changed as a
                                  result — two temporary diagnostics were
                                  added and fully removed within the same
                                  session (git-diff-verified net zero).
                                  This was the last open beta-blocking
                                  item; no P0/P1 engineering-quality
                                  findings remain open.
Outbox Auto-Recovery Trigger V1: COMPLETE (2026-09-09) — outbox recovery
                                  is now automatically triggered by app
                                  lifecycle (launch + foreground-resume,
                                  owned by `app/_layout.tsx` +
                                  `src/infrastructure/sync-recovery.ts`)
                                  rather than requiring another workout
                                  mutation. `SyncEngine.syncPendingCommands()`
                                  also gained a single-flight guard against
                                  overlapping runs. Native re-verified:
                                  relaunch alone (no additional logged set)
                                  recovered a real stranded SYNCING command
                                  to APPLIED with a single receipt. See
                                  docs/audits/V1-ENGINEERING-SECURITY-BASELINE.md's
                                  "Outbox Auto-Recovery Trigger V1" section.
Workout Sync Retry Coordinator:  IMPLEMENTED + AUTOMATED TESTS PASS +
                                  MANUAL RECONNECT VERIFIED (2026-10-04;
                                  Manual Test #4 CLOSED / PASS: API outage on
                                  Vostivo_Light, 2 offline sets, API
                                  restored with zero app interaction, the
                                  retry timer synced the original commands
                                  9.3 s after the API was reachable — same
                                  session, no duplicates, no
                                  REJECTED/CONFLICT). One app-owned
                                  `WorkoutSyncCoordinator` now drives every
                                  workout sync: post-mutation, launch/
                                  foreground, network regain (new dependency
                                  `expo-network`, needs a fresh dev build),
                                  and a 2/5/10/30 s capped retry after
                                  retryable failures — single flight,
                                  coalesced, idle when the outbox is empty.
                                  Contract: docs/architecture/
                                  WORKOUT-DATA-INTEGRITY.md "When sync runs".
Progression Prerequisites V1: IMPLEMENTED, natively verified (2026-09-09).
                                  `exerciseRef` is now synchronized,
                                  queryable canonical server workout
                                  reality (`app.performed_exercises
                                  .exercise_ref`,
                                  `CompleteSetCommandV1.exerciseRef`) —
                                  existing rows deterministically backfilled
                                  from their session's own prescription
                                  snapshot, proven against real dev data
                                  (13/14 rows recovered exactly). The
                                  remaining row's snapshot itself had no
                                  exerciseRef, so it was not fabricated or
                                  backfilled to null — it was conclusively
                                  synthetic native-verification fixture data
                                  (zero real command receipts, a throwaway
                                  single-session test identity) and was
                                  removed as an explicit dev-data cleanup,
                                  not a migration (Exercise Ref Legacy
                                  Reconciliation, 2026-09-09).
                                  `performed_exercises.exercise_ref` is now
                                  `NOT NULL` end-to-end — domain
                                  (`PerformedExercise.exerciseRef`),
                                  contract (`CompleteSetCommandV1
                                  .exerciseRef`), DTO completeness check,
                                  and Postgres schema all reject a null
                                  value; a direct null DB insert fails.
                                  `setType` (`WORKING`/`WARM_UP`) is
                                  explicit end-to-end — `PlannedSet`,
                                  `PrescribedSetV1`, `PerformedSet`,
                                  `CompleteSetCommandV1` — `NOT NULL`
                                  everywhere persisted, no nullable
                                  "null means WORKING" representation.
                                  `WorkoutHistoryService`
                                  (`apps/api/src/workout/`) gives a bounded,
                                  ownership-scoped read of recent WORKING
                                  exposures for one exerciseRef — no new
                                  HTTP endpoint. Load Resolver Stage 1
                                  (`resolveNextLoad`,
                                  `packages/domain/src/load/`) is pure/
                                  deterministic. Three indexes
                                  (`performed_exercises.exercise_ref`,
                                  `performed_sets.performed_exercise_id`,
                                  `workout_sessions.user_id`) were added
                                  after real EXPLAIN ANALYZE evidence, not
                                  speculatively. A real bug was found and
                                  fixed during native verification: an
                                  already-serialized `WorkoutPrescriptionV1`
                                  snapshot from before `setType` existed
                                  crashed `completeSet()` on a real device
                                  (`normalizeStoredPrescription()` now
                                  patches this at the read boundary — see
                                  `apps/mobile/src/workout/
                                  prescription-compat.ts`). No progression
                                  decision logic, no EngineDecision
                                  persistence, no Plan mutation, no RIR, no
                                  warm-up UI/generation exist yet. See
                                  docs/domain/PROGRESSION-ENGINE-V1.md for
                                  the approved spec this implements against.
                                  Next: Pure Progression Engine V1 (slice
                                  B) — implemented, see below.
Pure Progression Engine V1: IMPLEMENTED AND TECH-LEAD APPROVED (2026-09-22).
                                  `packages/training-engine/src/progression/`
                                  — `progressionPolicyV1` (`EnginePolicy<
                                  ProgressionEvaluationInput, "progression",
                                  ProgressionDecisionDataV1>`, version
                                  `{engine:"progression",policy:"v1"}`) and
                                  `evaluateProgression()`, a pure,
                                  deterministic double-progression policy
                                  per docs/domain/PROGRESSION-ENGINE-V1.md
                                  §12. Exactly three decisions
                                  (`NO_CHANGE`/`MAINTAIN_LOAD_BUILD_REPS`/
                                  `INCREASE_LOAD`) — no deload/decrease
                                  logic. Two stale spec/test-matrix
                                  conflicts (PROG-002 vs §11.1/OD-5; Worked
                                  Examples 1/8's unstated RIR assumption)
                                  and one real RANGE branch-precedence bug
                                  (a single set touching `maxReps` could
                                  mask a genuine regression in the other
                                  required sets) were all found and
                                  resolved during reconciliation — see
                                  §12.3.1 of the spec for the locked
                                  precedence rule and `policy.test.ts` for
                                  the regression-precedence test suite (64
                                  tests total). `pnpm boundaries:check`
                                  stays green (304 modules, 0 violations).
                                  See docs/audits/V1-ENGINEERING-SECURITY-
                                  BASELINE.md's "Production Readiness
                                  Backlog (Tech-Lead Review, 2026-09-22)"
                                  section for the release-readiness
                                  backlog recorded alongside this
                                  reconciliation (not implemented, no
                                  architecture changed).
Progression EngineDecision Persistence & Evidence Integration V1
                                  (slice C): IMPLEMENTED (2026-09-22).
                                  `ProgressionEvaluationService`
                                  (`apps/api/src/workout/`) assembles real
                                  canonical server workout history into
                                  `ProgressionEvaluationInput`, calls the
                                  unmodified `evaluateProgression()`, and
                                  persists the exact decision to
                                  `app.progression_decisions` — engine
                                  version, decision output, a full
                                  normalized-input snapshot, and
                                  `{performedSetId, revisionEvaluated}`
                                  evidence refs, all real-Postgres-tested
                                  (65 integration tests total, 23 of them
                                  progression-specific): idempotent under
                                  repeated and concurrent identical
                                  evaluation (DB-enforced unique
                                  fingerprint over source identity +
                                  every evidence revision, not "check then
                                  insert" — corrected 2026-09-23 identity
                                  gate: the fingerprint now also
                                  distinguishes a revision-only correction
                                  and two distinct sources with identical
                                  values, neither of which the original
                                  payload could tell apart), correction
                                  supersession proven via the real
                                  reopen/recomplete command path, and
                                  engine replay proven against a stored
                                  snapshot. `appliedAt` is `null` on every
                                  row this slice creates — no application
                                  mechanism exists. Automatic trigger
                                  wiring (deferred at the time this entry
                                  was written) is now implemented — see
                                  the Orchestration V1 entry below. **Not
                                  implemented, still**: any API endpoint,
                                  mobile UI, Progress UI, RIR persistence,
                                  warm-up UI/generation, and any
                                  ProgramVersion/PlannedSet mutation. **The
                                  product does not automatically adapt
                                  training yet** — a persisted decision is
                                  purely internal, unread by anything
                                  athlete-facing.
Progression Evaluation Orchestration
V1:                               IMPLEMENTED/VERIFIED (2026-09-23).
                                  `processWorkoutCommand`
                                  (`apps/api/src/workout/workout-command-
                                  processing.ts`) now enqueues a durable
                                  `progression-evaluate-session-v1` pg-boss
                                  job, in the SAME transaction as the
                                  canonical mutation (real commit/rollback
                                  atomicity proof, not simulated), on a
                                  genuine FINISH ACTIVE->COMPLETED
                                  transition and on a late-but-causally-
                                  valid COMPLETE_SET_V1/REOPEN_SET_V1
                                  against an already-COMPLETED session.
                                  `apps/worker` is now the ONLY caller of
                                  `ProgressionEvaluationService
                                  .evaluateAndPersist` — the athlete-facing
                                  logging path never evaluates progression
                                  inline. `ProgressionEvaluationService`/
                                  `WorkoutHistoryService` moved to a new
                                  shared package,
                                  `@vostivo/progression-application` —
                                  framework-agnostic (no @nestjs/*, no
                                  reflect-metadata; apps/api adapts it into
                                  Nest DI via useFactory providers) — so
                                  apps/worker never depends on apps/api
                                  source or NestJS (enforced by
                                  dependency-cruiser rules). Full detail:
                                  docs/domain/PROGRESSION-ENGINE-V1.md's
                                  "Progression Evaluation Orchestration V1
                                  implementation evidence" section.
                                  **Progression Application V1 is still
                                  NOT implemented** — no
                                  ProgramVersion/PlannedSet mutation, no
                                  automatic training adaptation; a
                                  persisted decision remains purely
                                  internal.
Progression Application V1:      ADR-0009 (effective-value overlay over
                                  immutable ProgramVersion) is ACCEPTED
                                  (2026-09-23) — architecture locked. Spec:
                                  docs/domain/PROGRESSION-APPLICATION-V1.md.
                                  One genuine open item remains:
                                  CoachingRelationship mechanics (does not
                                  block GUIDED/ADAPTIVE/EXPERT). Not
                                  implemented — no runtime code, schema, or
                                  migration changed.
Loading Capability Foundation V1: IMPLEMENTED/VERIFIED (2026-09-23).
                                  ADR-0010: Accepted. Schema
                                  (gym_profiles, loading_capabilities,
                                  exercise_loading_capability_bindings —
                                  migration 0010, purely additive) + pure
                                  domain ENUMERATED_LIST resolver
                                  (packages/domain/src/load/) + framework-
                                  agnostic lookup/write primitives
                                  (@vostivo/progression-application). No
                                  unit/basis-wide fallback — an explicit
                                  per-exercise binding only. Same-gym
                                  binding invariant is a real Postgres
                                  composite FK, empirically proven, not
                                  service-layer-only. Least privilege
                                  needed zero new grants (existing default-
                                  privilege mechanism already covers new
                                  app-schema tables). Full detail:
                                  docs/domain/LOADING-CAPABILITY-V1.md's
                                  "Implementation evidence" section.
                                  **Progression Application's own Apply
                                  workflow/overlay/GUIDED-auto-apply is
                                  still NOT implemented** — this slice is
                                  the foundation only.
Progression Application Slice B: implemented / verified / CLOSED
                                  (2026-09-23). Durable
                                  `progression_applications` +
                                  `progression_application_commands`
                                  workflow for `INCREASE_LOAD`
                                  EngineDecisions — Program Slot Identity,
                                  effectiveFrom boundary,
                                  KEEP_ORIGINAL/STALE/SUPERSEDED
                                  transitions, ownership-integrity
                                  composite FK. Full detail:
                                  docs/domain/PROGRESSION-APPLICATION-V1.md's
                                  §45-46.
Progression Application Slice C: implemented / verified / CLOSED
                                  (2026-09-24). Numeric Apply is real:
                                  PENDING_REVIEW -> APPLIED, effective Plan
                                  overlay, Loading Capability composition,
                                  immutable applied audit (migration 0013,
                                  purely additive). `progression_applications`
                                  itself is the overlay — no second
                                  "plan overrides" table; authored
                                  ProgramVersion/PlannedExercise/PlannedSet
                                  are never mutated. Historical
                                  (not just "current APPLIED") effective
                                  resolver wired into
                                  `PlanReadService.getWorkoutPreview()` —
                                  the only server path producing an
                                  effective load, so Preview and Workout
                                  Start (which snapshots Preview's own
                                  output) both reflect it. `ProgramVersion`
                                  row lock + a partial unique index
                                  serialize numeric Apply; a real
                                  Apply-vs-KEEP_ORIGINAL concurrency bug
                                  was found and fixed during this slice's
                                  own testing. Final binding-concurrency
                                  gate: verified (empirically, real
                                  Postgres) that the exact exercise ->
                                  LoadingCapability binding row is ALSO
                                  locked during Apply — not just the
                                  resolved capability row — via the
                                  existing joined `SELECT ... FOR UPDATE`
                                  (Postgres locks every joined table's rows
                                  by default); proven with a real
                                  concurrent-rebind race. Full detail:
                                  docs/domain/PROGRESSION-APPLICATION-V1.md's
                                  §47-48.
Progression Application Slice D: implemented / verified; final tech-lead
                                  approval pending (2026-09-24). The Final
                                  Durability / Crash-Window Gate has also
                                  passed: real Postgres + real pg-boss
                                  fault injection empirically proved both
                                  the before-dispatch and after-dispatch
                                  crash windows (same EngineDecision
                                  reused on retry, duplicate dispatch jobs
                                  allowed and converge safely, GUIDED never
                                  double-increments, systemCommandId
                                  stable across one job's own pg-boss
                                  retry). No schema change, no
                                  architecture change. NOT to be marked
                                  CLOSED here — that remains the tech
                                  lead's own call. Full detail:
                                  docs/domain/PROGRESSION-APPLICATION-V1.md's
                                  §50. Mode
                                  authority + durable orchestration: a
                                  pure `resolveProgressionAuthority`
                                  (GUIDED->SYSTEM_AUTO_APPLY, ADAPTIVE/
                                  EXPERT->ATHLETE_REVIEW), re-derived fresh
                                  from canonical `athlete_profiles.
                                  experience_mode` at dispatch time —
                                  current mode always wins, never a
                                  decision-time snapshot. A SEPARATE
                                  durable `progression-application-
                                  dispatch-v1` pg-boss queue/job (never
                                  the evaluation worker itself) idempotently
                                  ensures the workflow and, for GUIDED,
                                  invokes `applySystemProgression` — the
                                  EXACT SAME mechanical transaction core as
                                  the athlete Apply path, never a second
                                  implementation. Truthful `SYSTEM` actor
                                  audit (migration 0014, purely additive +
                                  backfilled): a new `actor_type`
                                  (ATHLETE/SYSTEM, not named
                                  `ExperienceMode` — `COACH` is a trivial
                                  additive follow-up once
                                  `CoachingRelationship` exists) column
                                  pair, `SYSTEM` never borrows the
                                  application owner's `userId`. Minimal
                                  authenticated athlete API: `GET
                                  pending`/`GET proposal`/`POST apply`/
                                  `POST keep-original`
                                  (`apps/api/src/progression/`), mode
                                  re-derived server-side on every gated
                                  call, GUIDED athletes see an empty
                                  pending list even when a real PENDING row
                                  exists from a failed system apply.
                                  **No CoachingRelationship/REVOKE/manual
                                  override/billing/RevenueCat/mobile UI
                                  implemented** — Smart Progression
                                  entitlement enforcement is documented as
                                  a release prerequisite (an outer access
                                  gate, never imported into
                                  packages/progression-application or
                                  packages/domain). Full detail:
                                  docs/domain/PROGRESSION-APPLICATION-V1.md's
                                  §49.
Next approved task (historical): Progression Application V1 — Slice E
                                  (mobile Today/Plan integration for
                                  review/apply surfaces using the
                                  already-approved Vostivo UX, while
                                  Guided remains mostly automatic) — since
                                  IMPLEMENTED (see Slice E below). Was blocked because its
                                  required Today surface did not exist;
                                  that blocker is now resolved by Athlete
                                  Mobile Today V1 Foundation (below). Do
                                  not auto-start Progression/Adaptation
                                  Engine, Athlete Memory, Coach Web,
                                  billing, pain/discomfort, exercise swap,
                                  or the Expert program builder without
                                  explicit approval.
```

```text
Athlete Mobile Today V1 Foundation: implemented / verified; awaiting
                                  tech-lead approval (2026-09-24).
                                  Prerequisite slice for Progression
                                  Application Slice E — Slice E's own UX
                                  spec assumed an existing Today screen
                                  with a Workout Hero, which did not exist
                                  (only `/` = Plan did); this slice built
                                  it. Routing: `/` is now the Today screen
                                  (`apps/mobile/app/index.tsx`, new); the
                                  existing Plan screen moved verbatim to
                                  `/plan` (`apps/mobile/app/plan.tsx`) —
                                  behavior unchanged, only its route
                                  changed. `BottomNav`
                                  (`src/ui/bottom-nav.tsx`) now really
                                  navigates Today/Plan (`router.replace`,
                                  never `push` — there is no `Tabs`
                                  navigator, only a `Stack`, so switching
                                  tabs must not grow the back stack);
                                  Progress/Profile remain visible but
                                  non-interactive, unchanged. All "what
                                  should the Hero show" logic lives in one
                                  pure, unit-tested function
                                  (`deriveTodayHeroState`,
                                  `src/plan/today-derivation.ts`) — loading
                                  / error / resume (an active session
                                  anywhere always wins) / no-plan /
                                  training-day / rest, using only
                                  server-owned signals already returned by
                                  the existing Plan contract
                                  (`PlanOverviewV1.sessions[].
                                  displayStatus`, never a device-local
                                  date/weekday). Start Workout reuses the
                                  EXACT SAME `PlanApplicationService.
                                  getWorkoutPreview`/`startWorkout` calls
                                  Workout Preview already uses — no second
                                  Start implementation. `active-workout.tsx`'s
                                  three exit paths (`router.replace("/")`)
                                  were left pointing at `/` unchanged
                                  (Today is now correctly the app's home
                                  surface) — only their "Back to Plan"
                                  copy was corrected to "Back to Today".
                                  Reserved composition point below the
                                  Hero for future event-driven content
                                  (Progression Review) renders `null` —
                                  no placeholder card. **No Progression
                                  Review, no Progress/Profile screens, no
                                  new server-state framework (still
                                  hand-written API client + local React
                                  state), no mobile SQLite change, no
                                  backend semantic change implemented** —
                                  all explicitly out of scope for this
                                  slice. Full detail: this update's own
                                  implementation report (not yet written
                                  into a dedicated doc — see the
                                  Documentation map entry for
                                  PLAN-PRESCRIPTION.md's own "Explicitly
                                  deferred" list, which listed "Full Today
                                  screen" before this slice).
Progression Application Slice E: implemented / verified; final
                                  presentation-integrity gate passed;
                                  awaiting tech-lead approval (2026-09-24).
                                  Athlete-facing exercise naming is
                                  canonical server truth ONLY — there is NO
                                  raw-`exerciseRef` fallback anywhere on
                                  this path (see the gate's own note
                                  below). Athlete Mobile Review Experience
                                  on the now-real Today surface: an
                                  event-driven
                                  Progression Review card in Today's
                                  reserved slot (`GET pending`, server
                                  already filters/orders — mobile never
                                  infers mode/authority, and renders at
                                  most one card, never more), a focused
                                  Review Detail route
                                  (`app/progression/[applicationId].tsx`,
                                  the same dedicated-Stack-route convention
                                  as Workout Preview — no bottom-sheet
                                  library exists in this repo) showing
                                  current/recommended load + a
                                  deterministic Why + Apply Change/Keep
                                  Original. Apply/Keep-Original send only
                                  `commandId` + the server-issued proposal
                                  precondition (`ApplyProgressionApplicationRequestV1`/
                                  `KeepOriginalProgressionApplicationRequestV1`,
                                  unchanged from Slice D) — never a
                                  client-chosen load/mode/actor.
                                  `PROPOSAL_REFRESH_REQUIRED` keeps the
                                  review open, silently refetches, shows a
                                  calm inline banner, and issues a NEW
                                  commandId for the required second
                                  confirmation — verified never
                                  auto-applies. No optimistic Plan
                                  mutation: Today/Plan both already
                                  refetch on their own `useFocusEffect`,
                                  which is the entire "refresh after
                                  Apply" mechanism — no new invalidation
                                  system was built. Additive, presentation-
                                  only contract change (task §7, final
                                  gate task §4): `PendingProgressionApplicationV1`
                                  AND `ProgressionApplicationProposalResponseV1`'s
                                  `AVAILABLE` variant both gained
                                  `exerciseDisplayName`, resolved
                                  server-side from the live
                                  `PlannedExercise` at the application's
                                  own exact Program Slot Identity
                                  (`resolveExerciseDisplayName`,
                                  `packages/progression-application/src/
                                  exercise-display-name.ts` — shared by
                                  both the pending list and the proposal
                                  resolver, same identity-match rigor as
                                  `computeRevalidation`'s own slot check).
                                  **Final presentation-integrity gate
                                  (2026-09-24, task §2/§3)**: the original
                                  raw-`exerciseRef`-fallback was removed —
                                  an application whose exact canonical
                                  slot can no longer be resolved is now
                                  OMITTED from the pending list entirely
                                  (a presentation filter only; the row's
                                  own persisted `status` is never
                                  transitioned by this read), and
                                  `resolveApplicationProposal` returns
                                  `UNAVAILABLE` rather than ever
                                  substituting the internal `exerciseRef`
                                  as athlete copy. Mobile Review Detail
                                  navigation now carries `applicationId`
                                  ONLY (`app/progression/
                                  [applicationId].tsx` — no
                                  `exerciseDisplayName` route param exists
                                  any more); the screen renders exclusively
                                  from its own freshly-fetched
                                  `proposal.exerciseDisplayName`, so a
                                  direct/deep-link open behaves identically
                                  to one reached via Today's card. No
                                  mobile lookup table, no other Slice-D
                                  contract or backend semantics touched.
                                  Offline:
                                  Apply/Keep-Original require connectivity
                                  (calm copy, no fake success, no mobile
                                  command journal); Start/Resume Workout
                                  and offline logging are completely
                                  unaffected. **No GymProfile/
                                  LoadingCapability configuration UX, no
                                  Coach, no REVOKE, no manual override, no
                                  new query/cache framework, no mobile
                                  SQLite change implemented** — all
                                  explicitly out of scope for this slice.
```

```text
Progression Application Slice F: implemented / verified; final
                                  Save-vs-Apply serialization gate passed;
                                  awaiting tech-lead approval (2026-09-24).
                                  Guided Blocked-Capability Recovery /
                                  Contextual Loading Setup V1. GUIDED
                                  remains fully
                                  automatic (task §0's hard distinction —
                                  the athlete configures PHYSICAL EQUIPMENT
                                  TRUTH here, never approves a progression
                                  recommendation; never converted into
                                  Apply/Keep-Original review, which remains
                                  exclusively ADAPTIVE/EXPERT's own Slice-E
                                  surface). `getGuidedLoadingSetupAttention`
                                  (`packages/progression-application/src/
                                  guided-loading-setup.ts`) surfaces at most
                                  one PENDING_REVIEW application whose
                                  latest SYSTEM Apply receipt was REJECTED
                                  for one of exactly five recoverable
                                  physical-configuration reasons
                                  (LOADING_CAPABILITY_UNAVAILABLE/INVALID,
                                  CAPABILITY_INCOMPATIBLE,
                                  CURRENT_LOAD_UNSUPPORTED,
                                  NO_SUITABLE_INCREMENT — never
                                  NO_CURRENT_LOAD/STALE/SUPERSEDED, which
                                  are Plan/workflow-state concerns, not
                                  equipment ones) and still revalidates as
                                  current; never a raw `exerciseRef`
                                  fallback (reuses the same
                                  `resolveExerciseDisplayName` boundary
                                  Slice E's own presentation-integrity gate
                                  established). Today shows a calm, non-
                                  alarming "Set Up Loading" card (never
                                  "Progression ready"/Apply/Keep Original)
                                  in the same reserved event-driven slot,
                                  mutually exclusive with the Slice-E
                                  review card by mode construction. A new
                                  contextual route
                                  (`app/progression/[applicationId]/
                                  loading-setup.tsx`, NOT a Profile screen)
                                  lets the athlete configure exactly two
                                  V1 shapes (FIXED_INCREMENT/
                                  ENUMERATED_LIST) for the exact bound
                                  exercise only — unit/basis are always
                                  server-derived from the application's
                                  current effective load, never client
                                  authority. Athlete-entered decimals are
                                  parsed by a new exact string-based
                                  parser (`parseExactDecimalToMilli`,
                                  `@vostivo/domain`) — deliberately never
                                  `parseFloat(text) * 1000`, to keep
                                  LOAD-INV-002's fixed-precision boundary
                                  free of floating-point ambiguity on the
                                  way in. **Tech-lead-locked write
                                  semantics (task §11)**: a submitted
                                  configuration that is semantically
                                  identical to the already-bound capability
                                  is reused verbatim (no duplicate row,
                                  natural retry idempotency); otherwise a
                                  NEW capability is created and ONLY the
                                  exact exercise is rebound to it — the
                                  contextual writer NEVER mutates a
                                  capability that may be shared by other
                                  exact-exercise bindings in place, proven
                                  directly (a shared capability plus two
                                  bound exercises; editing one forks a new
                                  capability while the shared row and the
                                  other exercise's binding are provably
                                  untouched). The writer's own binding-
                                  update path uses the exact same
                                  `resolveBoundCapabilityForUpdate` FOR
                                  UPDATE lock Slice C's own numeric Apply
                                  already uses, and never touches
                                  `ProgramVersion` at all, so it cannot
                                  participate in Apply's own lock-order
                                  cycle (task §16) — proven via a real
                                  5-way concurrent Save race, no deadlock,
                                  exactly one resulting capability. After a
                                  successful configuration commit, the
                                  SAME shared `applySystemProgression`
                                  SYSTEM-actor orchestration (Slice C/D's
                                  own mechanical core, never the human
                                  Apply endpoint) is retried as a genuinely
                                  separate durable step — a transient
                                  failure during that retry leaves the
                                  just-saved configuration intact
                                  (`SAVED_RETRY_FAILED`), proven via the
                                  same real-pg fault-injection methodology
                                  as the Slice D durability gate. **No
                                  Profile screen, no multi-gym, no
                                  equipment taxonomy, no Coach, no REVOKE,
                                  no manual override, no new mobile query/
                                  cache framework, no mobile SQLite change,
                                  no DB migration implemented** — all
                                  explicitly out of scope for this slice.
                                  **Final Save-vs-Apply serialization gate
                                  (2026-09-24)**: the initial report's
                                  5-way concurrent Save race proved
                                  Save-vs-Save safety only — it did NOT
                                  prove Save-vs-numeric-Apply serialization.
                                  Fixed: `saveGuidedLoadingSetup` now
                                  performs its full canonical revalidation
                                  (owner/current-GUIDED-mode/
                                  PENDING_REVIEW/`computeRevalidation`
                                  VALID) TWICE — once before entering the
                                  write flow (as before, a fast-fail), and
                                  a MANDATORY second time immediately after
                                  acquiring the exact binding/capability
                                  `FOR UPDATE` lock, using a plain unlocked
                                  re-read (never re-acquiring
                                  `ProgramVersion FOR UPDATE`, which would
                                  invert numeric Apply's own lock order —
                                  the writer still touches no resource
                                  Apply doesn't already lock in the same
                                  order). Under Postgres READ COMMITTED, a
                                  fresh statement issued right after
                                  waiting on that lock is guaranteed to
                                  observe a concurrent Apply that committed
                                  during the wait. Proven directly with two
                                  real-Postgres races (separate DB clients,
                                  no lock mocking, a small delay only
                                  biasing which side reaches the shared row
                                  first — Postgres itself resolves the
                                  actual contention): Save-wins ->
                                  numeric Apply resolves against the NEW
                                  capability (100kg + 5kg -> 105kg, audit
                                  snapshot = the new capability); Apply-wins
                                  -> Apply resolves against the OLD
                                  capability first (100kg + 2.5kg ->
                                  102.5kg) and the contextual Save's
                                  post-lock revalidation then correctly
                                  returns `NOT_RECOVERABLE` — the binding
                                  stays on the old capability, and the
                                  would-be new capability is never even
                                  created (not just left unbound). No
                                  schema change; no change to the
                                  shared-capability/identical-config-reuse/
                                  5-way-Save-race behavior already proven
                                  (re-run, still green).
```

```text
Available-Time Adaptation V1 Slice A: implemented / verified / CLOSED
                                  (2026-09-24). The
                                  first Training Intelligence vertical —
                                  PURE deterministic engine only
                                  (`packages/training-engine/src/
                                  available-time/`), no persistence/API/
                                  worker/mobile. A prior attempt at this
                                  slice correctly STOPPED (BLOCKED —
                                  METHODOLOGY GAP): the repository had no
                                  approved exercise-priority model
                                  (`PlannedExercise.role` was explicitly
                                  documented as "not implemented" in
                                  `docs/architecture/PLAN-PRESCRIPTION.md`)
                                  and no granular duration model (only a
                                  single author-entered
                                  `estimatedDurationMinutes` per whole
                                  workout). This tech-lead prompt resolved
                                  both gaps as new locked methodology —
                                  see `docs/domain/
                                  AVAILABLE-TIME-ADAPTATION-V1.md` for the
                                  full spec. Locked: explicit
                                  `priorityTier` (`TIER_1`/`TIER_2`/
                                  `TIER_3`) + `minimumWorkingSets` per
                                  normalized exercise (never inferred from
                                  `exerciseKey`/name/order); reduction
                                  order `TIER_3 -> TIER_2 -> TIER_1`,
                                  later-exercise-first within a tier,
                                  last-working-set-first within an
                                  exercise (strict suffix reduction); a
                                  single-pass "remove one set, re-estimate,
                                  stop the instant it fits" algorithm —
                                  never global/knapsack optimization; Time
                                  Estimation Policy `available-time/v1`
                                  (`60s` exercise setup + `30s` per
                                  retained set + authored `restSeconds`
                                  between retained sets, never after the
                                  last one — one named constant source,
                                  `duration.ts`); warm-ups fully protected
                                  unless the whole exercise is removed
                                  (only possible at `minimumWorkingSets =
                                  0`); a purely structural minimum session
                                  (no arbitrary global floor) that, if
                                  still too long, yields
                                  `CANNOT_FIT_MINIMUM` rather than ever
                                  violating an exercise's minimum. Result
                                  vocabulary: `NO_CHANGE`/
                                  `ADJUST_SESSION`/`CANNOT_FIT_MINIMUM`,
                                  never ambiguous/nullable; structurally
                                  invalid input is a distinct `Result.err`
                                  outcome, never silently mapped to any of
                                  the three. No mode/authority branch
                                  inside the engine (§13 — mechanical only).
                                  100 tests in `@vostivo/training-engine`
                                  (36 new), including the exact locked
                                  duration worked example, every §18
                                  A-M example class, and an explicit
                                  monotonicity invariant across 10 budgets.
                                  Full regression green; existing
                                  Progression Engine pure tests (64)
                                  re-run unaffected. **No persistence,
                                  API, worker, or mobile code — priority/
                                  minimum persistence, orchestration,
                                  mode authority, and the Today UI all
                                  remain explicit Slice-B+ decisions.**
```

```text
Available-Time Adaptation V1:
  - Slice A — CLOSED
  - Slice B — CLOSED (2026-10-05)
                                  SERVER-SIDE READ-ONLY PREVIEW: REAL PLAN
                                  -> server normalization -> pure
                                  `available-time/v1` -> preview. `POST
                                  /api/v1/plan/workouts/:plannedWorkoutId/
                                  available-time-preview` `{
                                  availableMinutes: 1..240 integer }`.
                                  Authored `priorityTier` +
                                  `minimumWorkingSets` live on
                                  `app.planned_exercises` (migration 0015,
                                  nullable = DB compatibility only, never a
                                  default; NULL -> preview fails closed).
                                  Owner-only via the Workout Preview
                                  ownership join (404 on not found/not
                                  owned); 409 WORKOUT_ALREADY_STARTED if an
                                  ACTIVE/COMPLETED session exists (Resume
                                  wins, shared `findMatchingSessions`); 422
                                  stable AVAILABLE_TIME_* codes for invalid
                                  authored structure. Only SELECTs —
                                  preview is not application; no decision/
                                  application/ProgramVersion/session/
                                  snapshot rows. `previewFingerprint` =
                                  SHA-256 canonical stale-input guard
                                  (Slice C), NOT auth. SMALL_FIXTURE
                                  authors Bench TIER_1/min 2, OHP TIER_2/
                                  min 0. Spec: `docs/domain/
                                  AVAILABLE-TIME-ADAPTATION-V1.md` §17.
                                  No mobile/Today UI, no start-adjusted
                                  workout (Slice C+).
```

```text
Available-Time Adaptation V1 Slice C — CLOSED (2026-10-05). Durable TODAY_ONLY
                                  application + adjusted offline-first
                                  START. Preview now returns exact
                                  per-exercise `retainedPlannedSetIds`/
                                  `removedPlannedSetIds` (all sets,
                                  canonical order, partition) +
                                  `sourceProgramVersionId`. Only
                                  ADJUST_SESSION is applicable (NO_CHANGE ->
                                  ordinary START; CANNOT_FIT refused).
                                  Mobile `AdjustedWorkoutStartService`
                                  (no UI): shared
                                  `availableTimeApplicationFromPreview`
                                  (contracts) + shared
                                  `selectAvailableTimePrescription`
                                  (domain) over the SAME effective Workout
                                  Preview prescription -> ONE SQLite tx:
                                  session + snapshot + application JSON
                                  (local migration 0012) + START outbox ->
                                  then requestSync. START_WORKOUT_SESSION_V1
                                  gains OPTIONAL `availableTimeApplication`
                                  (additive; ordinary START unchanged).
                                  Server: integrity (owned source, version,
                                  own set/exercise ids, snapshot == retained)
                                  -> REJECTED; re-runs available-time/v1
                                  BEFORE any write: a proven mismatch
                                  (fingerprint/result/durations/exact diff)
                                  -> REJECTED (no session, no row); else the
                                  START tx writes
                                  `app.available_time_applications`
                                  (migration 0016, one per session) with
                                  VERIFIED (exact + current) / STALE (exact,
                                  source no longer ACTIVE) / UNVERIFIED
                                  (owned source genuinely not re-evaluable —
                                  NEVER a fallback for mismatching data).
                                  Stale NEVER discards the session or
                                  rewrites its snapshot. Closure patch also
                                  hardened EVERY ordinary START: planned
                                  provenance must be owned (only own
                                  exercise/set ids), unplanned may carry no
                                  planned ids (`resolveStartProvenance`);
                                  injected-failure rollback proven.
                                  Multi-device starts of one planned
                                  occurrence: resolved by Planned Workout
                                  Occurrence Authority V1 (below). No
                                  ProgramVersion, EngineDecision,
                                  progression_application or Athlete Memory.
                                  Mobile tests now run the real repository
                                  SQL on real SQLite (`node:sqlite` behind
                                  drizzle's expo driver). Spec:
                                  `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`
                                  §18; ADR-0007 extension.
```

```text
Planned Workout Occurrence Authority V1 — CLOSED (2026-10-05). FIRST valid
                                  server-accepted START of a planned workout
                                  claims the occurrence (CANONICAL); a later
                                  distinct valid START (another device,
                                  offline) is still ACCEPTED as SECONDARY —
                                  real history (sets/reopen/finish/history/
                                  Available-Time row all preserved), never
                                  deleted/merged/promoted. CANONICAL != "the
                                  only real workout": it is the one session
                                  representing the occurrence for Plan/Today
                                  + planned progression. Model:
                                  `app.planned_workout_occurrence_claims`
                                  (migration 0017; UNIQUE (user, planned
                                  workout) + UNIQUE canonical session FK;
                                  role DERIVED, never stored), written in
                                  the START tx via ON CONFLICT DO NOTHING
                                  (race-safe across instances, no locks).
                                  One shared implementation in
                                  `@vostivo/progression-application`
                                  (`planned-occurrence-authority.ts`).
                                  `findMatchingSessions` resolves only via
                                  the claim (no last-row-wins). Progression:
                                  SECONDARY anchor ->
                                  NOT_CANONICAL_OCCURRENCE_SESSION (final,
                                  worker skips, no retry) and excluded as
                                  prior evidence. Unplanned STARTs never
                                  claim. Backfill: earliest server
                                  created_at (id tie-break) per OWNED
                                  occurrence. No wire change, no UI. Not
                                  solved (future): reconciliation/promotion/
                                  merge UX, informing the athlete.
                                  Docs: WORKOUT-DATA-INTEGRITY.md "Planned
                                  workout occurrence authority", ADR-0007.
```

```text
Available-Time Adaptation V1 — CLOSED (2026-10-05)
  - Slice A — CLOSED
  - Slice B — CLOSED
  - Slice C — CLOSED
  - Slice D — CLOSED / PASS (human acceptance on Vostivo_Light, 2026-10-05:
                                  Adjust time, no default time, NO_CHANGE,
                                  CANNOT_FIT_MINIMUM, preview failure + Retry
                                  keeping 8 min, changes-only ADJUST preview,
                                  OFFLINE local-first adjusted START,
                                  "Adjusted · 8 min", exact immutable
                                  prescription, PASSIVE reconnect sync via
                                  retry (~25.9 s), VERIFIED application,
                                  canonical occurrence claim, no duplicates;
                                  soft-keyboard behavior still wants a later
                                  physical-device smoke check — not a
                                  blocker; details: spec §19)
                                  Athlete UI: Today "Adjust time" (quiet,
                                  secondary; Resume wins) -> one sheet
                                  (SELECT_TIME / LOADING_PREVIEW /
                                  ADJUST_SESSION / NO_CHANGE /
                                  CANNOT_FIT_MINIMUM / PREVIEW_ERROR) ->
                                  explicit "Start adjusted workout" (all
                                  modes) -> Slice C local-first START ->
                                  Active Workout ("Adjusted · X min"
                                  sublabel only). No default time; changes-
                                  only preview; CANNOT_FIT never applicable;
                                  NO_CHANGE uses ordinary START; preview
                                  failure never blocks the original; 409 ->
                                  refresh Today. Pure flow + framework-free
                                  controller (`apps/mobile/src/
                                  available-time/`), RN built-in Modal, no
                                  new dependency. Offline-after-preview
                                  START proven on real SQLite. Spec:
                                  `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`
                                  §19.
```

```text
Missed Workout / Schedule Adaptation V1:
  - Slice A — CLOSED
                                  PURE deterministic policy
                                  (`packages/training-engine/src/
                                  missed-workout/`, `missed-workout/v1`).
                                  SEQUENCE BEFORE CALENDAR; ONE missed
                                  workout -> ROLL_FORWARD (never skip, never
                                  merge); everything needing judgment ->
                                  REVIEW_REQUIRED with fixed precedence. 40
                                  tests. Spec: `docs/domain/
                                  MISSED-WORKOUT-ADAPTATION-V1.md`.
  - Slice B — CLOSED
                                  READ-ONLY server preview: `POST /api/v1/
                                  plan/missed-workout-preview` (empty body).
                                  Explicit athlete IANA training time zone
                                  (`athlete_profiles.training_time_zone`,
                                  migration 0018, nullable, no backfill,
                                  never auto-overwritten; `PUT /api/v1/me/
                                  training-time-zone`); missing -> 409
                                  TRAINING_TIME_ZONE_REQUIRED, NO SILENT UTC
                                  FALLBACK. Injected server Clock -> athlete
                                  local date. Policy window = ACTIVE
                                  ProgramVersion's ONE current TrainingBlock
                                  (all its cycles); otherwise 409
                                  CURRENT_TRAINING_BLOCK_UNRESOLVED. Canonical
                                  state from Occurrence Authority claims
                                  only. V1 training slots = authored future
                                  dates of unresolved occurrences (app open
                                  / rest day never a slot). Production
                                  timeline FLEXIBLE. SHA-256 canonical
                                  previewFingerprint (stale guard, not auth).
                                  Zero mutations proven. Future application
                                  = effective schedule/sequence overlay, not
                                  ProgramVersion date mutation; explicit
                                  Apply in all modes. Spec §9.
  - Slice C — CLOSED
                                  DURABLE ROLL_FORWARD APPLICATION as an
                                  EFFECTIVE SCHEDULE OVERLAY. AUTHORED
                                  SCHEDULE IS IMMUTABLE; EFFECTIVE SCHEDULE
                                  IS AN OVERLAY; UNKNOWN AVAILABILITY
                                  REMAINS UNSCHEDULED; A CARRYOVER WORKOUT
                                  IS NOT SKIPPED; TODAY USES EFFECTIVE
                                  SCHEDULE; OCCURRENCE IDENTITY DOES NOT
                                  CHANGE WHEN SCHEDULE CHANGES; PREVIEW
                                  FINGERPRINT IS A STALE/IDEMPOTENCY GUARD,
                                  NOT AUTH. Migration 0019:
                                  `missed_workout_schedule_applications`
                                  (one ACTIVE per athlete+block, partial
                                  unique; UNIQUE fingerprint; ACTIVE ->
                                  SUPERSEDED only) + complete
                                  `missed_workout_schedule_assignments`
                                  snapshot (ROLL_FORWARD / RETAINED;
                                  carryover = effective NULL). Locked
                                  example: A Mon->Wed, B Wed->Fri, C Fri->
                                  Mon, D -> carryover. `POST /api/v1/plan/
                                  missed-workout-apply {previewFingerprint}`:
                                  profile FOR UPDATE -> idempotent replay ->
                                  same re-derivation as preview -> 409
                                  MISSED_WORKOUT_PREVIEW_STALE /
                                  MISSED_WORKOUT_NOT_APPLICABLE(+reasonCode)
                                  / TRAINING_TIME_ZONE_REQUIRED /
                                  CURRENT_TRAINING_BLOCK_UNRESOLVED ->
                                  supersede + insert in one tx. Preview now
                                  feeds EFFECTIVE dates (fingerprint schema
                                  v2 incl. active application id). Plan/
                                  Today/Workout Preview read the effective
                                  schedule (`PlanSessionSummaryV1`:
                                  `scheduledDate` = effective, additive
                                  `authoredScheduledDate`/`scheduleSource`).
                                  Second apply supersedes atomically. Spec
                                  §10.
  - Slice D — CLOSED (tech-lead confirmed Missed Workout V1 FULLY CLOSED,
                                  2026-10-17; implemented 2026-10-07)
                                  Athlete Today/Plan UX: calm Today card
                                  (below the Hero) -> one review sheet
                                  (missed / recommended next / changes-only
                                  diff / "Needs a training day") -> explicit
                                  "Apply update" sending ONLY the preview
                                  fingerprint (all modes; NO AUTO-APPLY) or
                                  "Not now" (no persistence). Success
                                  re-reads Today/Plan (effective schedule),
                                  never starts a workout. STALE -> re-preview,
                                  "Plan changed", fresh explicit Apply;
                                  REVIEW_REQUIRED -> "Plan needs review" +
                                  View plan (no Apply); offline Apply -> Retry
                                  / Not now, no local mutation. Plan: subtle
                                  "Adjusted" + "Originally Monday";
                                  carryover "Needs a training day". One-time
                                  training timezone bootstrap (device Intl
                                  IANA zone, only when the profile has none,
                                  never overwritten, no location
                                  permission). Mobile `src/missed-workout/`,
                                  `src/profile/`. Dev seed gains opt-in
                                  `MISSED_WORKOUT_FIXTURE=true`. Spec §11.

Temporary Equipment / Gym Adaptation V1 — FULLY CLOSED (2026-10-17)
  - Slice D — CLOSED / PASS (human acceptance on Vostivo_Light, 2026-10-17:
                                  preview Bench Press -> Dumbbell Bench Press and
                                  Overhead Press -> Seated Dumbbell Overhead Press;
                                  sets/reps/rest preserved; authored 60 kg / 30 kg
                                  not transferred; Not now persisted nothing; Apply
                                  did not auto-start; Today "Equipment adjusted · 2
                                  exercises"; NO_CHANGE "Use original workout"
                                  revert worked; after re-apply + START, Active
                                  Workout showed both substitutes with empty PREV
                                  and empty load fields, no authored Bench/OHP
                                  history, bottom navigation hidden). Implemented
                                  2026-10-12.
                                  Athlete mobile UX. START REMAINS PRIMARY;
                                  EQUIPMENT IS A CONTEXTUAL TODAY-ONLY DECISION;
                                  MOBILE NEVER OWNS THE CANONICAL EQUIPMENT
                                  CATALOG; USER SELECTS THE COMPLETE AVAILABLE
                                  INVENTORY FOR THIS SESSION; PREVIEW BEFORE
                                  APPLY; APPLY NEVER AUTO-STARTS; NO OPTIMISTIC
                                  SUBSTITUTION; SERVER EFFECTIVE PRESCRIPTION
                                  DRIVES START. New read-only `GET /api/v1/plan/
                                  equipment-adaptation-options?plannedWorkoutId=`
                                  (same applicability authority as the preview
                                  via `resolveEquipmentAdaptationTarget`;
                                  planned + curated-substitute equipment,
                                  canonical labels; today's applicable
                                  application's stored inventory). Today:
                                  quiet "Equipment" next to "Adjust time" ->
                                  sheet (nothing preselected, Everything
                                  available / Clear all) -> Review changes ->
                                  ADJUST (Apply changes / Not now) / NO_CHANGE
                                  (Done, or "Use original workout" = NO_CHANGE
                                  apply clear) / REVIEW_REQUIRED (no Apply);
                                  stale -> re-preview + new explicit tap.
                                  "Equipment adjusted · N exercises" from the
                                  server effective preview only. Mobile
                                  `src/equipment/`. Dev seed opt-in
                                  `EQUIPMENT_ADAPTATION_FIXTURE=true`. No
                                  migration. Spec §13.
  - Slice C — CLOSED (2026-10-12)
                                  DURABLE TODAY_ONLY APPLY + START. `POST /api/
                                  v1/plan/equipment-adaptation-apply {plannedWorkoutId,
                                  previewFingerprint, catalogVersion,
                                  availableEquipmentIds}` (strict) -> one tx:
                                  planned-occurrence advisory lock (START takes
                                  it too) -> idempotent replay -> SAME
                                  re-derivation as preview -> 409 EQUIPMENT_
                                  PREVIEW_STALE / EQUIPMENT_ADAPTATION_REVIEW_
                                  REQUIRED / Slice B codes -> supersede + insert.
                                  Migration 0020 `equipment_adaptation_
                                  applications` (one ACTIVE per occurrence;
                                  ACTIVE -> SUPERSEDED | CONSUMED; NO_CHANGE
                                  apply = auditable clear). AUTHORED PLAN NEVER
                                  MUTATED. Workout Preview (= START snapshot)
                                  applies a row only if re-deriving NOW yields
                                  its fingerprint; substitute = performed
                                  `exerciseRef` + additive `substitution`
                                  provenance (authored ref/name, application
                                  id); set ids/reps/rest kept; LOAD NEVER
                                  TRANSFERRED (substitute's own last uniform
                                  working load, else null; warm-up null).
                                  Order: schedule -> authored(+progression) ->
                                  equipment -> Available-Time (commute). START
                                  fails CLOSED on any mismatch with the durable
                                  replacements; consumes only ACTIVE + same
                                  local day + CANONICAL claim. Substitute never
                                  counts as authored: progression returns
                                  TEMPORARY_SUBSTITUTION_NOT_EVALUATED (worker
                                  final skip); ensureApplicationForDecision
                                  rejects exerciseRef != slot. No mobile change.
                                  START INTEGRITY CLOSURE FIX (2026-10-12): CLIENT
                                  CANNOT CHANGE EXERCISE IDENTITY AT START; EVERY
                                  EXERCISE IDENTITY CHANGE REQUIRES SERVER-
                                  VALIDATED SUBSTITUTION PROVENANCE; AN ACTIVE
                                  EQUIPMENT APPLICATION CANNOT BE SILENTLY
                                  BYPASSED BY STARTING THE AUTHORED EXERCISE;
                                  CANONICAL START LEAVES NO APPLICABLE ACTIVE
                                  EQUIPMENT APPLICATION BEHIND. Under the
                                  occurrence lock every slot must equal the
                                  server identity (authored, or the governing
                                  application's exact replacement + exact
                                  provenance); governing = consumed-by-canonical
                                  if started, else ACTIVE row applicable at
                                  startedAt OR server now. Canonical START:
                                  applicable ACTIVE -> CONSUMED, non-applicable
                                  ACTIVE -> SUPERSEDED (retired unused). No
                                  migration. Spec §12 (§12.5).
  - Slice B — CLOSED (2026-10-10)
                                  READ-ONLY server preview `POST /api/v1/plan/
                                  equipment-adaptation-preview {plannedWorkoutId,
                                  catalogVersion, availableEquipmentIds}`
                                  (strict). CLIENT SENDS COMPLETE SESSION
                                  AVAILABLE-EQUIPMENT INVENTORY; SERVER OWNS
                                  EXERCISE REQUIREMENTS AND SUBSTITUTION
                                  CANDIDATES; ADAPTATION REQUIRES ATHLETE-LOCAL
                                  TODAY; EFFECTIVE SCHEDULE WINS OVER AUTHORED
                                  DATE; UNKNOWN EXERCISE IDENTITY FAILS CLOSED;
                                  PREVIEW IS READ-ONLY; CATALOG VERSION
                                  PARTICIPATES IN PREVIEW STALENESS (version
                                  discipline now mandatory). 409 EQUIPMENT_
                                  CATALOG_VERSION_MISMATCH / TRAINING_TIME_ZONE_
                                  REQUIRED / EQUIPMENT_ADAPTATION_NOT_APPLICABLE
                                  (+reasonCode); 400 UNKNOWN_EQUIPMENT_ID; 404
                                  BOLA. No persisted lock/block exists ->
                                  ALLOW_TEMPORARY + empty blocked set (server
                                  constants). No migration. Spec §11.
  - Slice A — CLOSED
                                  PURE deterministic substitution policy
                                  (`packages/training-engine/src/
                                  equipment-adaptation/`,
                                  `equipment-adaptation/v1`). PRESERVE THE
                                  EXERCISE ROLE, CHANGE THE TOOL; SMALLEST
                                  NECESSARY CHANGE; SESSION-ONLY; CURATED
                                  SUBSTITUTES ONLY (ROLE_EQUIVALENT auto,
                                  ROLE_COMPATIBLE never); MACHINE OCCUPIED
                                  IS A REORDER PROBLEM FIRST; PRESERVE
                                  WORKING PRESCRIPTION, NEVER COPY LOAD
                                  (working or warm-up); ACTUAL EXERCISE
                                  HISTORY STAYS SEPARATE; NO WHOLE-WORKOUT
                                  REGENERATION; NO SILENT PARTIAL
                                  APPLICATION. NO_CHANGE / ADJUST_SESSION
                                  (in-place replacements + canonical session
                                  slots) / REVIEW_REQUIRED (LOCKED, NO_
                                  CURATED, NO_AVAILABLE, NO_EQUIVALENT,
                                  UNSUPPORTED_PRESCRIPTION, CONFLICT,
                                  AMBIGUOUS — fixed order). No persistence/
                                  API/UI; no equipment catalog exists yet
                                  (ids are caller input). 34 tests. Spec:
                                  `docs/domain/TEMPORARY-EQUIPMENT-
                                  ADAPTATION-V1.md`.

Full Athlete Journey E2E Audit V1: COMPLETE (2026-10-17) — AUDIT COMPLETE,
                                  PRODUCT GAPS FOUND. Real API + real worker
                                  against vostivo_manual (dedicated e2e
                                  athletes, wire-identical mobile commands):
                                  Today -> START -> offline sets -> lost-ACK
                                  replay -> FINISH -> COMPLETED -> worker
                                  INCREASE_LOAD -> GUIDED SYSTEM Apply -> next
                                  week's Upper Body A previews 62.5 kg (authored
                                  60 kg untouched); equipment + Available-Time
                                  on one occurrence composes (CONSUMED /
                                  VERIFIED, substitutes not evaluated). One
                                  correctness fix: COMPLETE_SET_V1 is now bound
                                  to the session snapshot (WDI-SYNC-011; see
                                  WORKOUT-DATA-INTEGRITY.md). Opt-in seed flag
                                  ATHLETE_JOURNEY_FIXTURE. Gaps (Progress/
                                  Profile not implemented, Start offered on a
                                  COMPLETED workout, "Rest day" after
                                  finishing, next cycle invisible in Plan, no
                                  sign-in UX): docs/audits/
                                  ATHLETE-JOURNEY-E2E-AUDIT-V1.md.

Progress & Feedback V1:           FULLY CLOSED (2026-10-19; scope approved
                                  2026-10-18). Spec:
                                  docs/domain/PROGRESS-AND-FEEDBACK-V1.md.
  - Slice A — Progress Read Model: CLOSED / tech-lead approved
                                  (2026-10-18). Read-only
                                  `apps/api/src/progress/`: GET /progress,
                                  /progress/workouts (keyset), /progress/
                                  workouts/:id, /progress/exercises/:ref.
                                  CANONICAL-ONLY (occurrence claim; SECONDARY
                                  never counts), owner-only (BOLA 404),
                                  substitutes never merged, improvements =
                                  APPLIED progression_applications only.
                                  Additive: PlanOverviewV1.athleteLocalDate,
                                  WorkoutPreviewExerciseV1.progression
                                  ("up from"). No migration.
  - Slice B — Mobile Progress MVP: CLOSED / tech-lead approved
                                  (2026-10-18; human acceptance deferred to
                                  Slice E). Progress tab is real
                                  (`app/progress/`: root, workout history
                                  with "Load more", workout detail, exercise
                                  history); framework-free controllers in
                                  `apps/mobile/src/progress/`; server is the
                                  only semantic authority (cursor verbatim,
                                  exact performed exerciseRef, no derived
                                  metrics). Closure fix: history days are
                                  ATHLETE-LOCAL — server `completedLocalDate`
                                  (training time zone via
                                  resolveScheduleDateContext), never the
                                  device zone.
  - Slice C — Progression feedback + next exposure: CLOSED / tech-lead
                                  approved (2026-10-19). Workout
                                  Preview shows "62.5kg · Up from 60kg" from
                                  server `progression` only; Progress "View
                                  next workout" opens the exact
                                  nextExposure as a READ-ONLY preview
                                  (`?source=progress`, no Start); Plan row
                                  "Progression applied" from additive
                                  `PlanSessionSummaryV1.hasAppliedProgression`
                                  (read from each occurrence's own Workout
                                  Preview); Today unchanged. Substitutes
                                  never inherit authored progression.
  - Slice D — Completed workout semantics: CLOSED / tech-lead approved
                                  (2026-10-19). HISTORICAL REALITY
                                  WINS. Additive server-owned
                                  `PlanSessionSummaryV1.completedWorkoutSessionId`
                                  and
                                  `WorkoutPreviewV1.completedWorkoutSessionId`
                                  — ONLY the caller's CANONICAL COMPLETED
                                  session (occurrence claim; SECONDARY /
                                  unclaimed / foreign never). Preview
                                  `canStart = no canonical session`.
                                  Plan COMPLETED row -> `/progress/workouts/
                                  :id`; Preview of a completed occurrence is
                                  read only ("Workout completed" + View
                                  workout); Today `completed-today` hero
                                  from `PlanOverviewV1.completedToday` —
                                  COMPLETED-TODAY IS SERVER-AUTHORITATIVE
                                  AND INDEPENDENT OF THE DISPLAYED PLAN
                                  CYCLE (closure fix: a previous-cycle /
                                  rolled-forward occurrence finished today
                                  counts; several -> most recently
                                  completed; training time zone, never
                                  device date) with no Start/Resume/
                                  Adjust/Equipment/missed card. The sync
                                  START command still accepts a deliberate
                                  SECONDARY session (domain capability kept,
                                  no UI). No migration.
  - Slice E — Human acceptance + final E2E: CLOSED / human acceptance PASS
                                  (2026-10-19). Real app on a dedicated new
                                  AVD `Vostivo_Progress_E2E` (dev build,
                                  Metro) + real API + real worker +
                                  `vostivo_manual`, fresh athlete
                                  `progress-e2e-1792424330` (GUIDED,
                                  Europe/Prague, EQUIPMENT_ADAPTATION_FIXTURE +
                                  ATHLETE_JOURNEY_FIXTURE, bench-press +2.5 kg
                                  capability). UI Start -> Bench 60 kg
                                  x 12/12/12 + OHP 30 x 10/10 -> Finish (7
                                  commands APPLIED, 1 session, 1 claim, no
                                  duplicates) -> worker INCREASE_LOAD -> SYSTEM
                                  APPLIED 60 -> 62.5 -> Today "Workout
                                  complete" + Next -> Plan row Completed ->
                                  history; deep-linked completed Preview has
                                  no Start -> Progress 60kg -> 62.5kg ->
                                  View next workout (exact server id) ->
                                  read-only "62.5kg · Up from 60kg". START
                                  target proven via snapshot == Preview
                                  prescription + PROGRESS-C-001 (no clock
                                  change). Evidence: spec §12. Follow-ups
                                  (non-blocking): Archivo, Plan/Today double
                                  fetch per focus + Plan preview-per-session
                                  (pre-beta perf), device-local DB not
                                  identity-scoped (sign-in phase).

Auth & Local Athlete Boundary V1: Phase 0 COMPLETE; decisions D-1..D-9
                                  APPROVED (2026-10-19): separate Supabase
                                  dev/prod projects, email OTP only,
                                  SecureStore session adapter, userId + one
                                  encrypted SQLite DB per athlete, legacy DB
                                  quarantine, Profile -> Account, dev-only
                                  identity selector, server first. Spec:
                                  docs/domain/AUTH-LOCAL-ATHLETE-BOUNDARY-V1.md.
  - Slice A — Server Receipt Ownership Hardening: CLOSED / tech-lead
                                  approved (2026-10-19). WORKOUT
                                  COMMAND IDEMPOTENCY IS OWNER-SCOPED:
                                  receipt PK (user_id, command_id)
                                  (migration 0021; user_id was always the
                                  actor, so no backfill/reassignment), one
                                  lookup findReceipt(userId, commandId);
                                  foreign-ownership rejections are stateless
                                  (no receipt), same-owner validation
                                  rejections still persisted. Known
                                  limitation: literal foreign replay of an
                                  UNPLANNED START takes the session id (Slice
                                  B prevents client-side). Spec §24.
                                  Closure audit (spec §25): repo-wide
                                  idempotency inventory; the same defect
                                  existed in progression_application_commands
                                  (global command_id -> another athlete's X
                                  answered A with COMMAND_CONFLICT) — fixed:
                                  PK (owner_user_id, command_id), owner = the
                                  application's owner (composite FK + CHECK
                                  athlete actor = owner), migration 0022
                                  backfilled from each row's own application.
                                  Every other namespace is owner-scoped by key
                                  or fingerprint, or server-only.
  - Slice B — Local Athlete Storage + IdentityGate: CLOSED /
                                  tech-lead approved (2026-10-20).
                                  NOTHING ATHLETE-OWNED EXISTS BEFORE READY:
                                  root IdentityGate (verified GET /me ->
                                  SecureStore sub->userId binding; offline
                                  only for a known binding) renders the tree
                                  keyed by userId; one SQLCipher DB + key per
                                  athlete (vostivo-athlete-<userId>.db);
                                  owner-scoped createAthleteRuntime (no
                                  module singletons) disposed before the next
                                  owner opens; sync token bound to the owner +
                                  batch ownerUserId (server 409
                                  SYNC_OWNER_MISMATCH, consistency guard not
                                  authz) — RCPT-005b closed in depth; legacy
                                  vostivo.db quarantined; __DEV__-only alias
                                  switcher. Human acceptance A->B->A +
                                  offline relaunch performed (spec §26.9).
  - Slice C — Supabase Auth + Session Lifecycle: CLOSED / TECH-LEAD
                                  APPROVED 2026-10-26 (human acceptance A-F
                                  + R passed, spec §27.8). Two UX fixes from
                                  acceptance D: same-owner re-auth reloads
                                  Today (AUTH-024); a load with no session
                                  shows "Sign in again to load your latest
                                  training." (SessionInvalidError, AUTH-023),
                                  never the owner-mismatch text. The
                                  acceptance-only Supabase JWT expiry (300 s)
                                  was restored to 3600 s on 2026-10-26.
                                  Follow-ups (non-blocking):
                                  see spec §27.9.
                                  SUPABASE IS THE IDENTITY PROVIDER ONLY
                                  (Data API disabled, no PostgREST use; one
                                  `createClient` in `src/auth/supabase-auth-
                                  client.ts`). Email + 6-digit OTP only;
                                  session in chunked, manifest-switched
                                  SecureStore (no AsyncStorage, fails
                                  closed). Env: mobile `EXPO_PUBLIC_SUPABASE_
                                  URL` + `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_
                                  KEY` (ANON_KEY removed; secret keys
                                  refused); API `SUPABASE_URL`, no
                                  `LOCAL_JWKS_PATH` for cloud tokens (no API
                                  code change). 401 = one single-flight
                                  refresh + one retry. Sync only while the
                                  owner is verified ONLINE with a VALID
                                  session; an invalid session keeps the
                                  owner's runtime (Active Workout usable,
                                  sync paused, "Sign in again to sync");
                                  same-owner re-auth resumes sync, other
                                  owner = Slice B transition; offline-bound
                                  boot re-verifies `/me` on network regain /
                                  foreground before syncing. Spec §27.
  - Slice D — Sign-out + Minimal Account: not started.
  - Slice E — Human Acceptance + Final Closure: not started.

Exercise & Equipment Reference Catalog V1: CLOSED. Code-owned reference data
                                  in `packages/domain/src/exercise-catalog/`
                                  (`exercise-equipment-catalog/v1`). EXERCISE
                                  REF IS THE CANONICAL EXERCISE IDENTITY;
                                  EQUIPMENT IDS ARE CANONICAL PRODUCT
                                  VOCABULARY; REQUIREMENTS ARE ALL-OF;
                                  SUBSTITUTION EDGES ARE EXPLICIT AND
                                  DIRECTIONAL; ROLE_EQUIVALENT IS CURATED,
                                  NEVER INFERRED; LOAD/HISTORY NOT IN
                                  CATALOG; NULL/UNKNOWN EXERCISES ARE NOT
                                  AUTO-ADAPTED; CATALOG IS REFERENCE DATA,
                                  NOT AVAILABILITY. Adapter
                                  `catalogEquipmentFacts` (training-engine).
  - Curated Substitution Seed V1 — CLOSED (2026-10-10). +7 exercises, +hack-squat-
                                  machine; 14 ROLE_EQUIVALENT edges (may be
                                  automatically RECOMMENDED for a temporary
                                  session substitution) + 8 ROLE_COMPATIBLE
                                  (review/manual only); neither transfers
                                  load/history/identity; a program/coach
                                  LOCK overrides equivalence. Squat-pattern,
                                  deadlift->RDL and bench->incline are
                                  compatible only. Version stays v1 (no
                                  persisted fingerprint uses it yet). Spec
                                  §10 of `docs/domain/EXERCISE-EQUIPMENT-
                                  REFERENCE-CATALOG-V1.md`.

Schedule Calendar Authority V1: CLOSED (2026-10-06). ONE ATHLETE-LOCAL CALENDAR
                                  AUTHORITY; UTC IS STORAGE/INSTANT CONTEXT,
                                  NOT TRAINING-DAY AUTHORITY; CURRENT MEANS
                                  DATE-CONTAINING, NOT NEAREST; ACTIVE
                                  PROGRAM SELECTION MUST BE DETERMINISTIC.
                                  `resolveScheduleDateContext` (domain) ->
                                  {localDate, source ATHLETE_TIME_ZONE |
                                  LEGACY_UTC_FALLBACK}; LEGACY_UTC_FALLBACK
                                  only for ordinary Today/Plan/Workout
                                  Preview reads while trainingTimeZone is
                                  NULL (temporary, isolated, never
                                  persisted); ADAPTATION NEVER USES IT
                                  (`requireAthleteTimeZoneDate`).
                                  `classifyScheduleCalendar` (domain):
                                  NO_SCHEDULE / BEFORE_PLAN /
                                  IN_CURRENT_BLOCK / GAP / AFTER_PLAN /
                                  AMBIGUOUS, nearby cycle only as a named
                                  `presentationCycle`;
                                  `selectCurrentTrainingCycle` removed.
                                  `resolveAthleteScheduleContext`
                                  (`apps/api/src/schedule/`) shared by
                                  PlanReadService (Today/Plan/Workout
                                  Preview) and Missed Workout. 2+ ACTIVE
                                  programs (the DB only enforces one ACTIVE
                                  version per program) -> 409
                                  ACTIVE_PROGRAM_AMBIGUOUS; overlapping
                                  cycles -> 409 CURRENT_SCHEDULE_AMBIGUOUS.
                                  PlanOverviewV1 gained additive
                                  `schedule {state, displayedCycle}`. No UI
                                  change. Spec: `docs/domain/
                                  SCHEDULE-CALENDAR-AUTHORITY-V1.md`.
```

```text
Local Manual E2E Backend: implemented / verified; device runtime pending
                                  (2026-10-01). Not a product feature — the
                                  infrastructure needed to run the real
                                  backend + a real mobile client by hand for
                                  the first time, entirely LOCAL/dev-only.
                                  Fixed a real production bug found while
                                  attempting this: `apps/api`'s pg-boss
                                  producer (`PgBossProducerModule`) used to
                                  crash the API on every boot
                                  (`UNSAFE_TRANSACTION`) because queue
                                  administration (`createQueue`'s own
                                  scripted BEGIN/COMMIT transaction) ran
                                  over the shared, ordinary POOLED Drizzle
                                  client — `postgres.js` refuses a raw
                                  multi-statement transaction over a pooled
                                  connection. Fixed by giving queue
                                  administration its own short-lived,
                                  native-`connectionString` `PgBoss`
                                  instance (the same pattern `apps/worker`
                                  already used), started and stopped once
                                  per API boot, strictly separate from the
                                  transactional producer (`fromDrizzle`
                                  over the ordinary pool, still used
                                  unmodified for the real per-transaction
                                  `.send()` redirect) — the normal API DB
                                  pool was never forced to `max:1`. Proven
                                  against real Postgres (reproduced the
                                  original crash, then proved the fix both
                                  when the queue already exists and when it
                                  does not, idempotently). Added real LOCAL
                                  JWT verification: `AuthModule` can now use
                                  a locally-generated JWKS
                                  (`apps/api/src/dev/generate-local-auth-
                                  key.ts` + `auth:local:mint-jwt`) through
                                  `SupabaseJwtVerifier`'s existing JWKS-
                                  injection seam — gated by a NEW
                                  `LOCAL_JWKS_PATH` config value that fails
                                  config validation outright outside
                                  `NODE_ENV=local` (`apiConfigSchema`'s own
                                  `superRefine`), so production/staging/
                                  development can never silently fall back
                                  to a local key. Not an auth bypass: the
                                  token is a real ES256-signed JWT,
                                  verified through the exact same
                                  `jwtVerify` call production tokens go
                                  through; bad signature/issuer/audience
                                  are all still rejected. A separate,
                                  isolated `vostivo_manual` database (never
                                  `vostivo_dev`) exists for this purpose —
                                  `packages/database/src/
                                  bootstrap-manual-db.ts` (`pnpm db:manual:
                                  reset`) drops/recreates it from scratch,
                                  with hard, independently-tested
                                  assertions refusing anything but
                                  `NODE_ENV=local` + a local host + the
                                  exact database name `vostivo_manual`.
                                  Proven end to end against real
                                  infrastructure: authenticated `GET /api/
                                  v1/me` creates a real athlete via the
                                  real identity-resolution path (no
                                  fabricated rows); `seed-dev-plan` extended
                                  with an optional `EXPERIENCE_MODE` write
                                  (ADAPTIVE) via a plain Drizzle update,
                                  since no product endpoint changes mode
                                  and this task explicitly forbade adding
                                  one; a real FIXED_INCREMENT Loading
                                  Capability was bound to Bench Press via
                                  the real `@vostivo/progression-
                                  application` write primitives (never raw
                                  SQL); a real workout (4 Bench Press
                                  working sets at the top of its 8-12 rep
                                  range) was completed through the real
                                  `/api/v1/sync/workout-commands` path; the
                                  real worker evaluated it and produced a
                                  real `INCREASE_LOAD` decision (60kg ->
                                  62.5kg, reason `TOP_OF_RANGE_ACHIEVED`,
                                  per docs/domain/PROGRESSION-ENGINE-V1.md
                                  §11.1 — a single exposure is sufficient,
                                  no prior history needed) and dispatched
                                  it to `PENDING_REVIEW` (ADAPTIVE ->
                                  `LEFT_FOR_ATHLETE_REVIEW`, left
                                  un-applied for the eventual human
                                  walkthrough); `GET pending`/`GET proposal`
                                  both correctly return it. **No mobile
                                  device/emulator/runtime target exists on
                                  the host this was built on — Android
                                  SDK/emulator installation remains
                                  explicitly out of scope and untouched; the
                                  actual mobile app has NOT been run.** Do
                                  not mark Local Manual E2E CLOSED until a
                                  real device/runtime target is chosen and
                                  the walkthrough is actually performed
                                  through the mobile app. See
                                  `docs/development/SETUP.md`'s "Manual
                                  end-to-end smoke testing" section.
```

```text
Completed foundation:     Monorepo, tooling, CI, all apps/packages
                           scaffolded, health endpoints, SQLCipher-encrypted
                           local DB + key-management boundary (verified on
                           a real Android native build/emulator), DB
                           migration infrastructure (server + local),
                           identity/auth foundation (User/AuthIdentity/
                           AthleteProfile, JWT verification via Supabase
                           JWKS, idempotent identity resolution,
                           GET /api/v1/me) — verified end to end against
                           real local Postgres and a real local JWKS HTTP
                           server, not just mocks. Mobile UUIDv7 domain-ID
                           generation (expo-crypto-backed, RNG-injectable,
                           no global polyfill) verified on a real Android
                           emulator with network disabled.
Latest slice:              Workout Data Integrity Vertical Slice — the
                           first real business vertical slice. Local-first
                           start/complete-set/reopen against SQLCipher-
                           encrypted SQLite, domain-aware outbox, revision-
                           gated conflict resolution (never timestamps,
                           never generic LWW), durable server-side command
                           idempotency, authenticated-actor-only
                           authorization with a passing BOLA negative
                           test. Verified end to end on a real Android
                           emulator: fully offline start/complete-set/
                           force-stop/relaunch/reopen with exact ID and
                           data preservation, then a real sync against a
                           real local API + Postgres, then a real replay
                           of an already-applied command proving zero
                           duplicates and no reversion of newer state. See
                           ADR-0007 and docs/architecture/
                           WORKOUT-DATA-INTEGRITY.md.
Current blockers:         None.
Current known tech debt:  ESLint major-version split (web/mobile on 9.x);
                           local SQLite migrations use a hand-rolled runner
                           instead of drizzle-kit's generated bundle
                           (unverified Metro/babel step); Auth Slice C
                           acceptance follow-ups (spec §27.9: decimal comma
                           in load input, no bounded timeout on offline
                           boot, re-auth pill overlap, one unreproduced
                           Fabric SIGSEGV);
                           `apps/mobile` requires `metro.config.js`'s
                           `unstable_enableSymlinks: true` for pnpm's
                           nested workspace symlinks (expo-doctor flags
                           this override by design — it is intentional,
                           do not remove it); no design-token/asset source
                           of truth exists yet beyond the locked palette/
                           spacing values now aligned in
                           `apps/mobile/src/design/tokens.ts` (still
                           provisional implementation infrastructure, not
                           the product design-system source of truth — see
                           docs/architecture/ACTIVE-WORKOUT.md); no
                           Archivo font files exist in this repo, so
                           typography still uses the OS system font;
                           `expo`/`expo-router` have a routine upstream
                           patch version drift (57.0.19/57.0.18 vs. the
                           SDK's expected 57.0.20/57.0.19) — not yet
                           bumped; the narrow `ExerciseIdentityV1` shim
                           (reusing `exerciseRef`) is not the full Exercise
                           Taxonomy — see docs/architecture/FOUNDATION.md,
                           docs/architecture/IDENTITY-AUTH.md,
                           docs/architecture/WORKOUT-DATA-INTEGRITY.md,
                           docs/architecture/PLAN-PRESCRIPTION.md, and
                           docs/architecture/ACTIVE-WORKOUT.md.
Active Workout visual polish (non-blocking, tracked for a future Claude
Design pass, not open functional blockers): no Archivo font files loaded
(system font substitutes); the set-table card gradient/well tones are a
close but not pixel-exact match to the canvas's exact stops; future
(not-yet-current) sets keep a small always-editable complete affordance
rather than the canvas's fully read-only treatment (deliberate, protects
existing out-of-order logging); exercise switching remains tap-to-jump
tabs rather than the canvas's implied swipe-paging.
Next approved task:       None assigned yet. Active Workout (logging,
                           Finish causal boundary, UX bug-fix pass, and
                           Claude Design visual alignment) is fully
                           approved — functionally and visually — as of
                           this update. Do not auto-start the next feature
                           (pain/discomfort contextual action, exercise
                           swap, Progression/Adaptation Engine, Athlete
                           Memory, Coach Web, billing, the complete Expert
                           program builder) without explicit approval.
Last meaningful update:   Active Workout Core Logger V1 — the real gym
                           logging experience, replacing the temporary
                           placeholder. LOG FIRST, EXPLAIN ON DEMAND:
                           Previous -> Today target -> Load -> Reps ->
                           Complete in one row, full-screen (no bottom
                           nav), backed entirely by
                           `getActiveWorkoutSession()` as the sole
                           authoritative source. Adds the required WDI
                           extension `FINISH_WORKOUT_SESSION_V1` (local-
                           first, BOLA-checked, idempotent, revision-free
                           one-way transition — see ADR-0007's
                           "Extension" section); a durable rest timer
                           (`startedAt`+`durationSeconds`, never a ticking
                           counter); local-only draft persistence
                           (`local_set_drafts`) cleared transactionally on
                           real completion; the narrow `ExerciseIdentityV1`
                           boundary (reusing the existing `exerciseRef`
                           pointer, not a new Exercise Taxonomy) enabling
                           "Previous" performance; and an optional
                           `PlannedSet.restSeconds`/`PrescribedSetV1
                           .restSeconds` carried through losslessly (real
                           Postgres migration, no other schema change).
                           Verified end to end on a real Android emulator:
                           full offline force-stop/relaunch mid-set with a
                           draft and an active rest timer both surviving
                           exactly, a reopen -> edit -> recomplete
                           progressing revision 1 -> 2 -> 3 (confirmed via
                           psql against a genuine `PER_IMPLEMENT` dumbbell
                           set), a Finish with 8 of 10 sets left
                           incomplete, and a replayed `FINISH_WORKOUT
                           _SESSION_V1` command against the real synced
                           session returning DUPLICATE with zero duplicate
                           side effects. A real bug was found and fixed
                           during that verification: `completeSet()`
                           originally always inserted a new row, so
                           recompleting a reopened set silently orphaned
                           the update instead of applying it — see
                           docs/architecture/ACTIVE-WORKOUT.md.
Fix pass:                 Active Workout final review pass — verified
                           COMPLETE_SET(r1)->REOPEN_SET(r2)->FINISH
                           ordering is safe by construction even when the
                           mobile SyncEngine's un-awaited sync calls race
                           over the network (two new real-Postgres tests,
                           AW-SYNC-007/008; no code change needed — see
                           ADR-0007/ACTIVE-WORKOUT.md's "Command ordering
                           around Finish"). Found and fixed a real draft-
                           durability gap: input was only persisted on
                           blur, so an abrupt kill while a field was still
                           focused (no blur ever fires) silently lost the
                           draft — confirmed natively, then fixed with a
                           ~400ms debounced auto-save read from refs (not
                           stale render closures); re-verified natively
                           that the fix holds, and that a kill within the
                           debounce window is a documented, accepted
                           residual gap, not a silent one. That review
                           also surfaced a real sync-ordering gap: neither
                           client nor server gated set mutations on
                           session-completion status, so the protocol
                           could not distinguish a legitimately-late
                           pre-Finish command from a genuinely new
                           post-Finish mutation. Fixed with a per-session
                           monotonic `sessionSeq` + a Finish `finishSeq`
                           watermark (never wall-clock-derived) — a local
                           terminal invariant now rejects any new
                           COMPLETE_SET/REOPEN_SET against an
                           already-locally-COMPLETED session (typed
                           outcome, zero new outbox command, verified
                           natively), and the server applies a matching
                           `sessionSeq <= finishSeq` causal gate with a
                           DB-level unique index as defense-in-depth. Not
                           a security mechanism — BOLA/ownership remains
                           the actual authorization boundary. See
                           ADR-0007's "Finish causal boundary" extension
                           and ACTIVE-WORKOUT.md.
UX bug-fix pass:          Fixed a real emulator/keyboard-config root cause
                           (`hw.keyboard=no` blocked physical keyboard
                           forwarding — not an app bug) plus three genuine
                           app bugs: numeric Load/Reps fields lacked
                           `selectTextOnFocus` and used lenient
                           parseInt/parseFloat instead of strict validation
                           (extracted to `numeric-input.ts`, unit-tested);
                           both screens' `ScrollView`s were missing
                           `style={{flex:1}}`; Workout Preview's
                           `router.push` left a stale "Starting…" screen
                           reachable via back navigation after an
                           already-active-session resume, fixed via
                           `router.replace` + an explicit retryable
                           `start-error` state + a visible Back affordance.
                           All natively verified.
Visual alignment pass:    Active Workout restyled to match the approved
                           Claude Design canvas ("Vostivo Active Workout
                           v2.dc.html") and Design System Foundations V1 —
                           compact icon-only Finish, compact rest timer,
                           gradient set-table card with completed/current/
                           future row states, single bottom "LOG SET N"
                           primary action. `tokens.ts` gained additive
                           `aw*`-prefixed keys only; every pre-existing key
                           Plan/Preview/nav depend on is unchanged in
                           value. Added `expo-linear-gradient` (rendering
                           primitive). Deliberate deviations from the
                           canvas (RIR/engine-note/Swap/Pain omitted as
                           still-deferred features; future sets stay
                           individually completable rather than read-only,
                           to avoid regressing out-of-order logging) are
                           documented in ACTIVE-WORKOUT.md. Functionally
                           and visually approved by tech lead.
```

Active Workout Core Logger V1 is implemented and natively verified —
completing the first full gym-logging loop (Plan -> Preview -> Start ->
log every set -> Finish -> summary). No other V1 product feature is
implemented — do not claim pain/discomfort, exercise swap, the
Progression/Adaptation Engine, Athlete Memory, Coach Web, billing, or the
complete Expert program builder have started.

## Documentation map

- **`README.md`** — what this repo is, layout, install, commands.
- **`docs/architecture/`** — `FOUNDATION.md`: topology, dependency
  directions, enforced boundaries, SQLCipher/key-management detail,
  known technical debt. `IDENTITY-AUTH.md`: JWT verification, identity
  resolution, `User`/`AuthIdentity`/`AthleteProfile`, request actor.
  `WORKOUT-DATA-INTEGRITY.md`: the offline-first workout logging slice —
  local persistence, sync protocol, native verification evidence.
  `PLAN-PRESCRIPTION.md`: the Program/Plan hierarchy, the Plan read
  model and Workout Preview, the WorkoutPrescriptionV1 handoff to WDI,
  and native verification evidence. `ACTIVE-WORKOUT.md`: the real gym
  logging screen — Finish Workout/`FINISH_WORKOUT_SESSION_V1`, rest timer
  and draft persistence, `ExerciseIdentityV1`/Previous performance, and
  native verification evidence. The architectural source of truth
  for _how the repo is built_.
- **`docs/development/`** — `SETUP.md`: prerequisites, install, running
  things, quality gates. The practical "how do I run this" reference.
- **`docs/domain/`** — locked domain specifications (e.g.
  `load-model-v1.md`). These define product-domain semantics in detail;
  this file intentionally does not duplicate them — read the relevant one
  before touching that domain area.
- **`adr/`** — one file per real architecture decision made and why. Check
  here before assuming a stack/tooling choice is up for debate.
- **`docs/audits/`** — point-in-time engineering/security/performance
  baseline audits. `V1-ENGINEERING-SECURITY-BASELINE.md` is the first —
  rate limiting, DB role separation, and Android backup policy are now
  LOCKED and implemented per the Security Hardening Follow-Up V1 update
  in that document; check it for the exact roles/env vars/limits before
  touching any of those three areas again.

## Maintenance rule

After every meaningful architecture decision, vertical slice completion,
new locked product decision, infrastructure change, major dependency
change, or known-risk discovery: **review whether this file needs
updating.**

`CLAUDE.md` is **not** a changelog — don't fill it with minor
implementation noise (a renamed variable, a small bugfix, routine
dependency patch bumps). It exists so a new session can quickly reconstruct
_what Vostivo is, what's locked, and where things currently stand_ — keep
it accurate and keep it short enough that a new session will actually read
the whole thing.
