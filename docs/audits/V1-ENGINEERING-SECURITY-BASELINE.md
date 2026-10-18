# Vostivo — V1 Engineering, Security & Performance Baseline Audit

Date: 2026-09-08. Scope: everything implemented through "Active Workout
Claude Design Alignment Pass" (see `CLAUDE.md`'s "Current project state").
This is **not** a new feature — it is a point-in-time review of what has
already been built, comparing documented architecture against real
implementation, and applying narrow, low-risk fixes where they were
objectively safe to make without a product/architecture decision.

**Update (Security Hardening Follow-Up V1, same date)**: this audit was
reviewed and accepted by the tech lead. Three P1-before-beta findings
(AUD-008 rate limiting, AUD-015 Postgres least privilege, AUD-021 Android
backup policy) received locked tech-lead decisions and were implemented
and verified in that follow-up pass — their rows below are now marked
**FIXED**, with evidence. AUD-028's `fastify` advisories were
re-investigated with exact reachability analysis (both are currently
**NOT REACHABLE** in Vostivo's actual runtime configuration — see the
updated breakdown). This document is edited in place rather than
duplicated; superseded "proposed, not implemented" language has been
replaced with what was actually built and proven.

**Update (Native Android Sync Recovery Re-Verification, 2026-09-09)**:
AUD-041 (the stranded-`SYNCING`-command reliability fix) has now been
proven on a real Android emulator (`Pixel_7_Vostivo_Clean`), outside
Vitest — real `adb shell am force-stop`, real encrypted local SQLite,
real local Postgres, real lost-ACK scenario. Status changed from "native
re-verification pending" to **NATIVE ANDROID VERIFIED** — see the updated
matrix row and the new "AUD-041 native verification evidence" section
below. This was the last open beta-blocking item from both prior passes.

**Update (Production Readiness Backlog, 2026-09-22)**: the tech lead
completed a broad architecture/security/production review covering
observability, production database/environment readiness, horizontal
scale, dependency/security recheck cadence, offline connectivity, real
mobile auth, iOS verification, release identifiers, performance/load
testing, privacy/legal lifecycle, billing/entitlement, website release
hardening, and Git repository hygiene. **Nothing in that review was
implemented in this pass** — it is recorded as a prioritized backlog (see
"Production Readiness Backlog" below) so it is not forgotten before
beta/public release, alongside this task's other narrow responsibility
(fixing the Pure Progression Engine V1 RANGE branch-precedence bug — see
`docs/domain/PROGRESSION-ENGINE-V1.md` §12.3.1, unrelated to this audit).
No locked architecture decision was changed by this review — see that
section's own "Architecture impact: NONE" statement.

This document reports what was **locally verified** against this specific
codebase at this specific commit-in-progress. It never claims formal
compliance with any external standard — see "Language used in this
document" at the end.

## Executive summary

**Verdict: YES, WITH MATERIAL GAPS.**

Vostivo's implemented slices (Foundation, Identity/Auth, Workout Data
Integrity, Plan & Prescription, Active Workout) are built with a level of
rigor — real transactional idempotency, real BOLA checks on every
resource, real revision-gated conflict resolution, real native SQLCipher
verification, a genuinely clean dependency-boundary enforcement, zero
`any`/`@ts-ignore` escape hatches in authored source, zero secrets in the
tree — that is well above what is typical for a project at this stage.
The team has consistently found and fixed real bugs during *native*
verification rather than trusting unit tests alone, which is exactly the
right instinct for an offline-first mobile system.

**Update**: the three infrastructure-hardening P1s this section originally
flagged (rate limiting, DB least-privilege, Android backup policy) are now
implemented and verified against real Postgres/real Expo config — see the
Security Hardening Follow-Up V1 note above and the matrix below.

The gaps found were real but bounded: they clustered around infrastructure
hardening that was correctly deferred while there was no real traffic to
harden against (rate limiting, DB least-privilege, CI integration
coverage), one genuine reliability bug in the sync outbox (fixed during
this audit), and a set of decisions that are explicitly product/ops
choices the audit correctly declines to make silently (Android backup
policy, release identifiers, dependency version-skew tradeoffs).

## Scope

Everything staged in the first Git checkpoint (261 files, still staged,
untouched by this audit — see "Git/index status"): `apps/api`,
`apps/mobile`, `apps/web`, `apps/worker`, all `packages/*`, root tooling
(`turbo.json`, `tsconfig.base.json`, `.dependency-cruiser.cjs`,
`.github/workflows/ci.yml`, `docker-compose.yml`), and `docs/`/`adr/`.
Explicitly out of scope: Progression/Adaptation Engine, Athlete Memory,
Coach Web, billing, Pain/Swap/RIR, any UI redesign.

## Standards used (verification baseline only — see closing note)

- **OWASP ASVS 5.0.0** — web/API, Level 2 mindset.
- **OWASP MASVS/MASTG** — MASVS-STORAGE, -CRYPTO, -AUTH, -NETWORK,
  -PLATFORM, -CODE, -RESILIENCE, -PRIVACY.
- **OWASP API Security Top 10 (2023)**.
- **NIST SP 800-218 SSDF v1.1** (final, not draft v1.2).

## Architecture review

Documentation in `docs/architecture/*.md` and `adr/*.md` was read in full
and compared against the real source, not assumed correct. It matches the
real implementation closely — the one place documentation was ahead of
code is `docker-compose.yml`'s DB role model (see AUDIT-018 below), which
the docs correctly describe as a "previously locked" requirement without
claiming it was already implemented. No other doc/code divergence was
found. `pnpm boundaries:check` (262 modules, 572 dependencies) reports
zero violations, and manual inspection of `packages/domain` and
`packages/training-engine` imports confirms this is a real enforced
boundary, not a green check nobody trusts.

## Findings matrix

Severity: **P0** credible data loss / cross-user access / auth bypass /
exposed secret / corrupted canonical truth. **P1** should block beta.
**P2** should block public production release. **P3** future hardening.

| ID | Area | Finding | Status | Severity | Evidence |
|----|------|---------|--------|----------|----------|
| AUD-001 | Auth | JWT verification is cryptographic (jose+JWKS), pins issuer+audience, never decodes-without-verifying | PASS | — | `apps/api/src/auth/supabase-jwt-verifier.ts` |
| AUD-002 | Auth | Verification failure is always a generic 401, no internals leaked | PASS | — | `auth.guard.ts:43-45` |
| AUD-003 | Authz | Every controller derives ownership from `AuthenticatedActor`, never request body/params | PASS | — | `plan.controller.ts`, `workout-command-processing.ts` (every `applyX`) |
| AUD-004 | BOLA | Cross-athlete access attempts return uniform not-found/rejected, no existence leakage | PASS | — | `plan.controller.ts:33-37`, `workout-command-processing.ts:215,316,367`, existing negative tests (WDI-SYNC-008, PLAN-API-002, AW-SYNC-003) |
| AUD-005 | Mass assignment | `ValidationPipe({whitelist:true, forbidNonWhitelisted:true})` rejects unknown fields globally | PASS | — | `main.ts:29-34` |
| AUD-006 | Input validation | Per-field `class-validator` decorators on every sync command field; malformed command → `REJECTED`, not a 500 | PASS | — | `workout-command.dto.ts`, `workout-sync.service.ts:26-33` |
| AUD-007 | DoS/resource limits | Sync batch array had **no upper bound** — a client could submit an unbounded `commands[]` in one request | **FIXED** | P2 | `workout-command.dto.ts` — added `@ArrayMaxSize(500)`, documented constant `MAX_COMMANDS_PER_SYNC_BATCH` |
| AUD-008 | Rate limiting | No rate limiting existed anywhere in the API | **FIXED** | P1 | `@fastify/rate-limit` registered globally in `main.ts` (`apps/api/src/common/rate-limit.ts`), env-configurable via `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SECONDS` (default 300/60s), `TRUST_PROXY` defaults `false`; `rate-limit.test.ts` (4 tests, real Fastify request cycle: allowed, 429, window recovery, sustained-normal-use) + `api-config.test.ts` (4 tests) |
| AUD-009 | Security headers | `@fastify/helmet` registered globally, correct order (before routes) | PASS | — | `main.ts:20-21` |
| AUD-010 | CORS | No CORS plugin/config exists | NOT APPLICABLE (rationale below) | — | no `@fastify/cors` in any `package.json`; native mobile traffic is not CORS-governed; `apps/web` has no code calling the API yet |
| AUD-011 | CSRF | Bearer-token-only auth, no cookie-based session | NOT APPLICABLE | — | `auth.guard.ts` only reads `Authorization: Bearer` |
| AUD-012 | Error handling | Central `ErrorEnvelopeFilter`, no raw stack traces/SQL errors to clients | PASS | — | `apps/api/src/common/filters/error-envelope.filter.ts` |
| AUD-013 | Logging privacy | `pino` configured with `redact: ["*.password","*.token","*.secret","*.authorization"]`; no full JWTs, DB creds, or SQLCipher keys logged anywhere found by inspection | PASS | — | `packages/observability/src/logger.ts`; `database-key.ts` never logs the key |
| AUD-014 | Supabase Data API exposure | No hosted Supabase project exists; architecture (mobile/web → Nest API → private Postgres schema) never exposes tables via a Data API | NOT RUN (no hosted project) / architecture PASS | — | `docs/architecture/IDENTITY-AUTH.md`; grep confirms no `service_role`/Supabase Data API client anywhere |
| AUD-015 | Postgres least privilege | `docker-compose.yml`'s single `vostivo` role was both the migration owner **and** the API's runtime `DATABASE_URL` role — no separation existed | **FIXED** | P1 | New least-privilege `vostivo_api` role, bootstrapped idempotently by `packages/database/src/bootstrap-roles.ts` (`pnpm db:bootstrap-roles`); `apps/api`'s `DATABASE_URL` and all 3 pre-existing integration test files now default to it; real-Postgres denial proof in `apps/api/src/database/db-privilege.integration.test.ts` (6 tests) — see below |
| AUD-016 | Schema security | No `SECURITY DEFINER` functions; all queries go through Drizzle's parameterized query builder; the one raw-SQL-adjacent path (`sql\`...\`` in `workout-command-processing.ts`) only ever interpolates Drizzle column references, never string-concatenates user input | PASS | — | grep for `sql\`` across `apps/api`, `packages/database` |
| AUD-017 | DB constraints | Partial unique indexes back every "at most one" invariant found in code (`program_versions` active-version, `workout_command_receipts` sessionSeq) rather than relying on TypeScript alone | PASS | — | `packages/database/src/schema/plan.ts`, `.../workout.ts` |
| AUD-018 | Transactions/concurrency | Identity resolution, command processing, and the Finish causal boundary are all correctly transactional with proven race handling (unique-violation catch-and-reread, not blind retry) | PASS | — | `identity-resolution.ts`, `workout-command-processing.ts:86-146`; existing tests AW-ORDER-001/002/005/006/007/008 |
| AUD-019 | Mobile SQLCipher | Key→open→PRAGMA key→verify→migrate ordering enforced by a single exported entrypoint; natively verified with wrong-key-rejection and process-restart persistence | PASS | — | `docs/architecture/FOUNDATION.md`'s native verification section |
| AUD-020 | SecureStore | Key generated via `expo-crypto` CSPRNG, 256-bit, never logged, no AsyncStorage fallback, format-validated before PRAGMA interpolation | PASS | — | `database-key.ts`, `secure-store.ts` |
| AUD-021 | Android backup policy | No `allowBackup=false` config existed — Android's default `allowBackup=true` applied, risking an unreadable restored SQLCipher DB paired with a lost/regenerated Keystore-backed key | **FIXED** (tech-lead decision: disable backup entirely) | P1 | `apps/mobile/app.json`: `android.allowBackup: false`; verified via `expo config --type public` (`android.allowBackup: False`) and a temporary `expo prebuild` confirming `android:allowBackup="false"` in the real generated `AndroidManifest.xml` (removed afterward, CNG-clean); decision documented in `docs/architecture/FOUNDATION.md` |
| AUD-022 | Production cleartext networking | No hardcoded cleartext URL found outside `.env.local` (gitignored); `EXPO_PUBLIC_API_BASE_URL` is externally configured, not hardcoded | PASS (config discipline); NOT RUN (no real prod API base URL/HTTPS-enforcement test exists yet, since no prod deployment exists) | — | grep for `http://` across `apps/mobile/src`, `app/` |
| AUD-023 | Dev JWT safety | Double-gated (`EXPO_PUBLIC_VOSTIVO_ENV != production` AND `EXPO_PUBLIC_DEV_JWT` set), fails closed on unset/unrecognized env, no `__DEV__` gate (deliberately, so it works in release builds used for offline verification) | PASS | — | `plan-runtime-config.ts`, `plan-runtime-config.test.ts` |
| AUD-024 | Mobile account isolation | Real mobile sign-in is still deferred; local DB has no per-user namespacing since only one "user" can exist per device today | DEFERRED BY DESIGN (tracked as P1, tied to real auth implementation) | P1 (future) | `docs/architecture/IDENTITY-AUTH.md` "Mobile auth foundation" |
| AUD-025 | Mobile permissions | Only `expo-router`, `expo-sqlite`(SQLCipher), `expo-secure-store` plugins; no camera/location/contacts/health permission requested | PASS | — | `apps/mobile/app.json` |
| AUD-026 | CNG/native hygiene | No committed `android/`/`ios/` directories; both gitignored; confirmed absent from the working tree | PASS | — | `.gitignore:32-34`; `find` confirms absence |
| AUD-027 | Release identifiers | Android package is still `com.anonymous.vostivo` (Expo's default placeholder) | P2 BEFORE PUBLIC RELEASE (decision required, not silently changed) | P2 | `apps/mobile/app.json` |
| AUD-028 | Dependency/supply chain | `pnpm audit --prod`: 6 advisories, incl. 2 moderate `fastify` CVEs. Both confirmed **NOT REACHABLE** in Vostivo's actual runtime config after a focused re-investigation. See breakdown below. | MIXED (see below) | mixed | `pnpm audit` output; GHSA-w2qp-rph6-63g4, GHSA-3m5p-2c4r-xxw2 |
| AUD-029 | Lockfile reproducibility | `pnpm install --frozen-lockfile` passes cleanly; Node pinned via `.nvmrc`/CI `node-version: 24.20.0`; pnpm pinned via CI `version: 11.25.0`; no mixed npm/yarn lockfiles | PASS | — | ran directly during this audit |
| AUD-030 | CI/secrets scanning | CI ran only lint/typecheck/boundaries/unit-tests/build — the real-Postgres integration suite never ran in CI | **FIXED** | P1 | `.github/workflows/ci.yml` — `postgres:17-alpine` service + migration + **DB role bootstrap** + `test:integration` step; now runs 38 tests (32 original + 6 new `db-privilege.integration.test.ts`) using the least-privilege runtime role |
| AUD-031 | GitHub platform hardening | No git remote configured at all — branch protection, required checks, Dependabot, secret scanning are all platform features of a repo that doesn't exist on GitHub yet | NOT RUN (no remote) | — | `git remote -v` → empty |
| AUD-032 | Secret scanning | Deep grep (JWT-shaped strings, `service_role`, PEM private-key headers, `postgres://user:pass@`) across the full working tree found nothing beyond the documented local-dev placeholder credential | PASS | — | ran directly during this audit |
| AUD-033 | TypeScript quality | Zero `any`, `as any`, `@ts-ignore`, `@ts-expect-error` in any authored source file (only matches are in `apps/web/.next/` generated build output, which is gitignored) | PASS | — | repo-wide grep |
| AUD-034 | Domain boundaries | `pnpm boundaries:check` green, and manual inspection of `packages/domain`/`packages/training-engine` imports confirms no framework leakage | PASS | — | see "Architecture review" |
| AUD-035 | Contract versioning | Every wire contract (`WorkoutPrescriptionV1`, `RepTargetV1`, sync commands) carries an explicit `V1`/`schemaVersion` marker; malformed/unversioned commands are rejected, not silently coerced | PASS | — | `workout-command.dto.ts:40-41` (`@IsIn([1])`), `workout-sync.service.ts:26-33` |
| AUD-036 | Local SQLite indexing | `sync_outbox` query filters on `status`/`created_at`; no index audit found a query pattern currently slow enough at V1 data volumes to justify one — not added speculatively | PASS (no action needed) | — | code inspection; no realistic V1 dataset large enough to demonstrate a regression |
| AUD-037 | Postgres performance | No realistic production-scale dataset exists yet to EXPLAIN against; the schema's existing FK/unique indexes cover every ownership/lookup join used by `PlanReadService`/`workout-command-processing.ts` | NOT RUN (no realistic dataset) | — | see "Performance baseline" below |
| AUD-038 | Active Workout performance | Timer isolated to its own component (no full-tree rerender per tick); no per-keystroke SQL write (400ms debounce); Complete path is local-only, no network in critical path | PASS | — | `docs/architecture/ACTIVE-WORKOUT.md` "Rest timer", "Draft persistence"; `app/active-workout.tsx` |
| AUD-039 | Memory/resource leaks | `WorkoutHeader`'s `setInterval` is scoped to its own component; no evidence of duplicate timers across remounts found by inspection | PASS (inspection only — no automated leak test exists) | — | code inspection |
| AUD-040 | Sync engine reliability | Auth-refresh failure, network timeout, and 5xx are all correctly classified as retryable, never permanent; duplicate resend reuses the same `commandId` | PASS | — | `sync-engine.ts:54-83` |
| AUD-041 | Sync engine reliability — stranded commands | `getPendingCommands()` excluded `'SYNCING'` status — a process kill during an in-flight sync request permanently stranded those commands outside the retry loop, silently violating the locked "local + outbox eventually atomic" guarantee | **FIXED — NATIVE ANDROID VERIFIED** | P1 | `apps/mobile/src/workout/workout-repository.ts` — added `'SYNCING'` to the query; proven on a real Android emulator (real `am force-stop`, real encrypted SQLite, real Postgres) — see "AUD-041 native verification evidence" below |
| AUD-042 | Server batch semantics | Commands within one sync batch are processed **independently** (each in its own transaction), not batch-atomically — one malformed command cannot roll back or block other valid commands in the same request | PASS (now explicitly documented here) | — | `workout-sync.service.ts:22-33` (`for` loop, not `Promise.all`/shared transaction) |
| AUD-043 | Accessibility | No screen-reader-hostile patterns found in a code-level review (no color-only state without a paired accessible label, touch targets follow `touchTarget.minHeight: 44`); no real screen-reader device test performed | PASS (code-level only) / NOT RUN (device-level) | — | `apps/mobile/src/design/tokens.ts:126-128`; no VoiceOver/TalkBack session run this audit |
| AUD-044 | Web baseline | `apps/web` is two placeholder route groups with no real content, no forms, no auth, no user data; no security headers/CSP/robots.txt configured yet | P3 (harmless at current placeholder-only state) | P3 | `apps/web/next.config.ts` (empty config); `apps/web/src/app/(coach)/coach/page.tsx` |
| AUD-045 | Privacy/data inventory | Current data: external auth subject, optional email, athlete profile, workout history/performed sets, local encrypted drafts. None of it currently flows to any analytics/logging vendor (none is wired up) | PASS (nothing to leak yet); export/deletion/retention workflow NOT RUN (no such feature exists) | — | code inspection; no analytics SDK present anywhere in dependency tree |
| AUD-046 | Backup/recovery (Postgres) | No production Postgres deployment exists; migration pipeline (`drizzle-kit` + `migrate.ts`) is the only "recovery" mechanism verified so far | NOT RUN (no production instance) | — | `packages/database/src/migrate.ts` |
| AUD-047 | iOS gap | Zero native iOS runtime verification has been performed on this Linux machine (SQLCipher, Keychain, safe-area, native build) | NOT RUN (explicitly, required before iOS beta) | — | this machine cannot build/run iOS |
| AUD-048 | Expo/OTA/release config | CNG-consistent; no runtime version/OTA channel/code-signing configured yet — release-hardening decision, not a current blocker | DEFERRED BY DESIGN | P3 (future) | `apps/mobile/app.json` |
| AUD-049 | Expo Doctor | Same 2 known warnings re-verified: Metro symlink override (intentional, required for pnpm workspace) and expo/expo-router patch drift (57.0.19/57.0.18 vs 57.0.20/57.0.19) | PASS (both classified, neither auto-fixed) | — | ran `npx expo-doctor` directly during this audit — 19/21, identical to prior sessions |
| AUD-050 | Test strategy | Critical invariants (BOLA, idempotency, revision gating, Finish causal boundary, identity concurrency) all have real tests; the one meaningful hole found is AUD-030 (integration suite not in CI), now fixed | PASS (after fix) | — | see file-by-file test inventory in architecture docs |
| AUD-051 | Dead/duplicated code | The `active-workout.tsx` diagnostic `console.log` instrumentation flagged for re-check was confirmed **fully removed** — no match found | PASS | — | grep confirms zero matches |
| AUD-052 | Package/architecture complexity | `packages/config` + `packages/observability` + `packages/test-fixtures` together are only ~100 lines and each protects a real, currently-used boundary (env validation, log redaction, deterministic fixtures) — not ceremony | PASS | — | line count + import-site inspection |

### Dependency/supply-chain breakdown (AUD-028)

`pnpm audit --prod` reports 6 advisories:

**`fastify` (2 moderate) — re-investigated in the Security Hardening
Follow-Up V1 pass with the exact advisory text, not just titles:**

| Advisory | CVE | Affected | Fixed | Exact vulnerable code path | Vostivo exposure |
|---|---|---|---|---|---|
| GHSA-w2qp-rph6-63g4 | CVE-2026-18504 | `<5.12.1` | `5.12.1`+ | A **root-level primitive** (not object/array) HTTP body schema, validated with Fastify's own default type coercion — the coerced value is checked, but the *original, uncoerced* value is what reaches the route handler. | **NOT REACHABLE.** Vostivo never registers a Fastify-native `schema` option on any route (confirmed: `grep -rn "schema:" apps/api/src` finds none outside test files). Every request body is validated exclusively through NestJS's `class-validator`-based global `ValidationPipe` — a structurally different validation layer this advisory does not affect — and every DTO's top-level shape is an object (`SyncWorkoutCommandsRequestDto { commands: [...] }`, `WorkoutCommandDto {...}`), never a bare root primitive, even if that layer existed. |
| GHSA-3m5p-2c4r-xxw2 | CVE-2026-16732 | `>=5.8.3 <5.12.1` | `5.12.1`+ | Specifically the **numeric hop-count form** of `trustProxy` (e.g. `trustProxy: 1`) — its address-matching predicate is broken and effectively trusts `X-Forwarded-*` headers from anyone. The advisory states plainly: "if `trustProxy` is left at its default value (false), this vulnerability does not apply." | **NOT REACHABLE.** `apps/api/src/common/config/api-config.ts`'s `TRUST_PROXY` is a **boolean**, not numeric, and defaults to `false` (Fastify's own safe default) — see AUD-008. Vostivo's config surface cannot even express the vulnerable numeric-hop-count form; enabling `TRUST_PROXY=true` in the future trusts the standard boolean form (a different, already-understood risk — "trust every forwarded header," which is why it defaults off), not this specific broken hop-count predicate. |

**Why not upgraded anyway, for defense-in-depth**: attempted during the
original audit and re-confirmed in this follow-up. `pnpm why fastify`
shows `@nestjs/platform-fastify@11.2.3` (the latest published release
compatible with NestJS 11.x, per ADR-0004's "not NestJS 12") declares an
**exact-pinned** `"fastify": "5.11.3"` dependency (not a semver range) —
`npm view @nestjs/platform-fastify@11.2.3 dependencies` confirms this
directly. Overriding `apps/api`'s own `fastify` to `5.12.x` therefore
cannot dedupe against that pin, forcing two incompatible `fastify`
installations side by side (proven: this breaks `tsc` with a
`FastifyInstance` structural-incompatibility error). No newer
`@nestjs/platform-fastify` 11.x release exists to resolve this
(`11.2.3` is the latest at time of writing). **Resolution trigger**:
re-attempt once NestJS publishes a `platform-fastify` release depending
on `fastify >=5.12.1`, or once ADR-0004 is revisited to allow NestJS 12.
Do not force a `pnpm.overrides` in the meantime — an unverified
cross-version fastify instance is a worse, less-understood risk than two
advisories with confirmed zero exposure. Tracked as a P2 (not P1): both
preconditions for exploitation are absent by construction, not by luck.

- **`uuid@7.0.3` (moderate)**, **`image-size@1.2.1` (high)**,
  **`decode-uri-component` (moderate)** — all are transitive dependencies
  many levels deep inside Expo/Metro/React Native's own build tooling
  (`pnpm why` traces confirm this), never reachable from any Vostivo
  application code at runtime. Classified **dev/build-tooling only, not a
  production runtime exposure** — routine upstream drift, not
  auto-upgraded per this task's "do not auto-major-upgrade" instruction.

## AUD-041 native verification evidence

Performed on the existing known-good emulator (`Pixel_7_Vostivo_Clean`),
a real debug dev-client build, real local Postgres, and a temporary real
local JWKS/JWT issuer (same established pattern as every prior native
verification session — removed afterward). Two temporary, development-
only diagnostics were used and fully removed afterward (git-diff-verified
zero net source change): (1) an env-gated (`EXPO_PUBLIC_DEBUG_SYNC_DELAY_MS`,
never in `.env.example`) artificial delay in `FetchWorkoutSyncApiClient
.syncCommands()`, inserted after `markSyncing()` already commits and
before the network call, solely to widen the process-kill window to a
reliable, non-racy size; (2) a deep-link diagnostic screen
(`dev-sync-verify.tsx`, same pattern as the WDI slice's
`dev-workout-verify.tsx` precedent) that queries `sync_outbox` through
the normal encrypted local-database layer and logs structured results —
never reads or logs the SQLCipher key.

**Scenario**: start a real workout, complete Set 1 (syncs normally),
complete Set 2 — real `adb shell am force-stop com.anonymous.vostivo`
issued while the artificial delay held the sync request pending, i.e.
genuinely *before* the HTTP request was even sent.

- **Process-death evidence**: `adb shell am force-stop` confirmed (`ps`
  showed zero matching processes immediately after); Postgres confirmed
  **zero** `workout_command_receipts` row for that `commandId` — the
  server never received the request at all. This is a stronger proof
  than a mid-flight network cut: the command was durably `SYNCING`
  locally with no corresponding trace server-side whatsoever.
- **SQLite durability evidence** (captured *before* the kill, through the
  diagnostic screen, via real `adb logcat`): `commandId=01a08595-...
  type=COMPLETE_SET_V1 status=SYNCING attempts=1`.
- **Post-relaunch evidence**: cold-started the app fresh (new PID) —
  the same commandId was still `status=SYNCING, attempts=1`, proving the
  row survived the process death exactly as written, not corrupted or
  silently reset.
- **Recovery evidence**: logging one more set (Set 3) triggered
  `syncPendingWorkoutCommands()`, which — because of the fix — included
  the stranded row in `getPendingCommands()`'s result. Real logcat
  afterward: the **same** `commandId=01a08595-...` now shows
  `status=SYNCED, attempts=2` (incremented, proving it was genuinely
  re-attempted, not just left alone). At the time, sync only fired as a
  side effect of a logging action (no mount-time or periodic trigger) —
  **closed by the Outbox Auto-Recovery Trigger V1 follow-up (2026-09-09)**:
  app launch and foreground-resume now also trigger
  `syncPendingWorkoutCommands()` (`app/_layout.tsx` +
  `src/infrastructure/sync-recovery.ts`), re-verified natively without
  logging another set — see that follow-up's evidence below.
- **Idempotency/lost-ACK evidence**: `app.workout_command_receipts` shows
  exactly one row for that `commandId`, `outcome=APPLIED`. Querying
  `performed_sets` scoped to the real session shows exactly 3 rows (Sets
  1/2/3), each `revision=1` — no duplicate row, no orphaned reality, no
  data corruption from the interrupted request.
- **Finish causal boundary smoke check**: finished the session
  (`finish_seq` recorded as `3` server-side, matching the 3 real
  `sessionSeq` allocations). A genuinely new post-Finish mutation —
  crafted directly against the real running API (`REOPEN_SET_V1`,
  `sessionSeq=4 > finishSeq=3`) — was **REJECTED**, and the target set's
  `completion_state`/`revision` were confirmed unchanged in Postgres. The
  pre-Finish-eligible case (`sessionSeq <= finishSeq`) is exactly what
  the Set-2 recovery above already proved applies safely; the full
  AW-ORDER-00x matrix remains covered by the existing automated
  real-Postgres integration suite (still green — see regression results).
- **Logging independence**: every set completion (including the one that
  was later interrupted mid-sync) showed an immediate local checkmark
  with no visible wait — local durability never depended on the network
  call succeeding, before or after the crash.

**Cleanup performed**: both temporary diagnostics fully removed
(`git diff` on the touched source file is empty; the new diagnostic
screen file was deleted, never committed); the temporary local JWKS
server script deleted; the generated `android/` directory removed again
(CNG strategy); no test JWTs, log dumps, or screenshots were added to the
repository — all evidence above was captured to a local scratch directory
outside version control.

## Outbox Auto-Recovery Trigger V1 (2026-09-09 follow-up)

Closes the "Recovery evidence" finding above: sync previously only ever
fired as a side effect of a workout mutation, so an app relaunch alone
never reconciled a durable `PENDING`/`RETRY`/`SYNCING` outbox command.
`SyncEngine.syncPendingCommands()` and the retry/idempotency protocol are
unchanged — this only adds two new automatic triggers and a single-flight
guard around the existing engine:

- **Lifecycle owner**: `app/_layout.tsx` (application bootstrap), not the
  Active Workout screen — `src/infrastructure/sync-recovery.ts`
  (`startOutboxSyncRecovery`) is framework-agnostic (no `react-native`
  import, same boundary philosophy as `OutboxPort`) and unit-tested with
  a fake `AppLifecycleSource`; only `app/_layout.tsx` wires the real
  `AppState`.
- **Triggers implemented**: app launch (fires once on mount) and
  foreground-resume (`AppState` transition to `"active"`). (Superseded
  2026-10-04: network regain and a bounded retry backoff were added — see
  AUD-057.) Network-regain triggering was a deliberate, documented deferral — this repo has no
  already-supported lightweight connectivity-observation dependency (no
  NetInfo/expo-network), and one was not added solely for this narrow
  fix.
- **Concurrency**: `SyncEngine.syncPendingCommands()` gained a
  single-flight guard (concurrent callers share one in-flight run's
  result) — overlapping triggers (a mutation, a resume, a relaunch) can
  no longer cause duplicate concurrent sync requests. Covered by a new
  test in `sync-engine.test.ts`.
- **Native re-verification** (same established pattern: real
  `Pixel_7_Vostivo_Clean` emulator, real debug dev-client build, real
  local Postgres, a temporary real local JWKS/JWT issuer — both fully
  torn down afterward): started a real workout, logged Set 1 (synced
  normally), logged Set 2 with a temporary artificial delay in
  `FetchWorkoutSyncApiClient.syncCommands()` (inserted after
  `markSyncing()` commits, before the network call — the same technique
  as the original AUD-041 verification), then `adb shell am force-stop`
  within that window. Confirmed via `app.workout_command_receipts`: zero
  row for Set 2's `commandId` immediately after the kill (request never
  reached the server). Relaunched the app **without logging another
  set** — the new launch trigger alone produced exactly one new
  `APPLIED` receipt for that same `commandId` (`session_seq=2`) once the
  artificial delay elapsed, and the app UI showed the set as completed
  with no error state. The artificial delay was fully reverted afterward
  (`git diff` on `workout-sync-api-client.ts` is empty); no diagnostic
  screens or scripts were added to the repository.
- **Regression**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm
  boundaries:check` all pass repo-wide after the change and after
  reverting the temporary delay.

## Safe remediations implemented

All of the following meet every criterion in the task's safe-remediation
policy: objectively incorrect/insecure, inside already-approved scope, no
product decision required, no destructive migration, no new vendor, and a
regression test exists or was run.

1. **`workout-command.dto.ts`** — added `@ArrayMaxSize(MAX_COMMANDS_PER_SYNC_BATCH)`
   (500) to `SyncWorkoutCommandsRequestDto.commands`. Closes AUD-007 (an
   unbounded sync-command array). 500 is generous headroom above any
   realistic offline gap while bounding worst-case per-request DB work.
2. **`main.ts`** — the Swagger/OpenAPI `/docs` UI now only registers when
   `config.NODE_ENV !== "production"`. Closes a minor config-hardening gap
   (browsable API surface is a dev convenience, not a release artifact).
3. **`.github/workflows/ci.yml`** — added a `postgres:17-alpine` service
   container, `DATABASE_URL`/`SUPABASE_URL` env vars, a migration step,
   and a `pnpm --filter @vostivo/api test:integration` step. Closes
   AUD-030: the 32 real-Postgres tests proving BOLA/idempotency/revision-
   gating/Finish-causal-boundary now actually run on every PR, not just
   locally.
4. **`workout-repository.ts`** — `getPendingCommands()` now includes
   `'SYNCING'` alongside `'PENDING'`/`'RETRY'`. Closes AUD-041, a real
   reliability bug where a process kill mid-sync could permanently strand
   commands outside the retry loop.

**Security Hardening Follow-Up V1** (locked tech-lead decisions,
implemented and verified against real Postgres/real Expo config):

5. **Postgres least privilege** (closes AUD-015) —
   `packages/database/src/bootstrap-roles.ts` (new, `pnpm
   db:bootstrap-roles`) idempotently creates a `vostivo_api` role with
   `USAGE` on the `app` schema, `SELECT/INSERT/UPDATE/DELETE` on every
   current table, `USAGE`/`SELECT` on every current sequence, and matching
   `ALTER DEFAULT PRIVILEGES` so a *future* migration-created table is
   automatically usable without a developer remembering a manual grant —
   with **no** `SUPERUSER`/`CREATEDB`/`CREATEROLE`/`CREATE TABLE`/`DROP
   TABLE`/`ALTER TABLE`. `packages/database/src/config.ts` splits
   `DATABASE_URL` (runtime role) from a new `MIGRATION_DATABASE_URL`
   (admin role, used only by `migrate.ts`/`bootstrap-roles.ts`/
   `drizzle.config.ts`). `apps/api`'s `DATABASE_URL` and all 4 real-Postgres
   integration test files now default to the runtime role. Proven with
   real PostgreSQL permission failures (SQLSTATE `42501`), not grant
   inspection — see `apps/api/src/database/db-privilege.integration.test.ts`.
6. **API rate limiting** (closes AUD-008) — `@fastify/rate-limit`
   registered globally (`apps/api/src/common/rate-limit.ts`), generous
   env-configurable defaults (`RATE_LIMIT_MAX=300`,
   `RATE_LIMIT_WINDOW_SECONDS=60`), `TRUST_PROXY` defaults `false`. A
   single global rule covers `/sync/workout-commands` too — no separate
   route override, since the 500-command-per-request batch cap (AUD-007)
   already absorbs "many small updates" into one request, so a
   request-count limit doesn't need to be relaxed further for it (see
   `rate-limit.ts`'s doc comment for the full reasoning). Real
   request-cycle tests (not mocked) in `rate-limit.test.ts`.
7. **Android backup policy** (closes AUD-021) — `apps/mobile/app.json`:
   `android.allowBackup: false` (tech-lead decision: disable entirely
   rather than the two more surgical alternatives that were also
   proposed). Verified through `expo config` and a temporary `expo
   prebuild` against the real generated `AndroidManifest.xml`. Decision,
   rationale, recovery model, and known limitation documented in
   `docs/architecture/FOUNDATION.md`.

All four changes were verified against the full regression suite (see
below) — including the real-Postgres integration suite for #1 and #2, and
the mobile Vitest suite for #4 (though #4's specific SQL predicate change
is not exercised by any existing unit test, consistent with this
repository's established "verified natively, not unit-tested" precedent
for `WorkoutRepository` — flagged below as needing native
re-verification, not silently claimed as fully proven).

## Resolved by the Security Hardening Follow-Up V1

The three P1s this audit originally left as "proposed, not implemented"
(AUD-008 rate limiting, AUD-015 Postgres least privilege, AUD-021 Android
backup policy) each received an explicit tech-lead decision and are now
implemented and verified — see their matrix rows above and "Safe
remediations implemented" items 5–7. Their original proposed designs are
no longer reproduced here (superseded by what was actually built); the
`fastify` investigation is now inline in the AUD-028 breakdown above with
exact advisory text and a reachability conclusion, not a guess from the
advisory title.

## Proposed, not implemented (STOP/REPORT/PROPOSE — section 55)

### AUD-027 — Release identifiers

`com.anonymous.vostivo` remains the Android package identifier. This is a
one-way decision (changing it later means a new app listing, not an
update) and is explicitly a product/business decision, not an engineering
one — flagged, not changed.

## Security baseline

- **Auth**: `jose` + Supabase JWKS, issuer+audience pinned, no shared
  secret, no manual cryptography. Locally verified against a real local
  JWKS test issuer (see architecture docs' native verification sections).
- **Authorization**: BOLA enforced at every resource boundary found
  (Plan, Workout Preview, all four sync command types) via
  `AuthenticatedActor`, never request-supplied IDs. Negative tests exist
  for each.
- **API**: Helmet registered, global validation with
  whitelist/forbidNonWhitelisted, centralized error envelope, no CORS
  (correctly N/A for the current mobile-only client), no CSRF (correctly
  N/A for bearer-only auth), sync batch size now bounded.
- **Mobile**: SQLCipher natively verified end-to-end including wrong-key
  rejection; SecureStore-only key storage; dev-JWT override fails closed
  in production; no unnecessary permissions.
- **Database**: parameterized queries throughout, partial unique indexes
  back the invariants that matter, least-privilege role separation is a
  documented but not-yet-implemented gap (AUD-015).
- **Secrets**: none found in the tree beyond a documented local-dev
  placeholder; `.env.local`/`.env` correctly gitignored everywhere.
- **Supply chain**: lockfile reproducible and frozen-install-clean; the
  one production-relevant CVE pair (`fastify`) has a real fix blocked on
  upstream NestJS compatibility, not ignored.

## Reliability & data integrity

Offline-first guarantees hold under direct code inspection and the
extensive native-verification evidence already on record: local-first
writes, outbox pattern, durable server-side idempotency
(`workout_command_receipts`), revision-gated convergence (never
last-write-wins), the `sessionSeq`/`finishSeq` causal boundary around
Finish, and independent (non-atomic-batch) per-command server processing
so one bad command can't take down a whole sync batch. One real gap was
found and fixed (AUD-041, stranded `SYNCING` commands after a process
kill) — this is exactly the kind of defect this audit exists to catch,
and it directly threatened the project's own locked "local + outbox
eventually atomic" guarantee.

## Performance baseline

No realistic production-scale dataset exists to produce a credible
`EXPLAIN ANALYZE` baseline (the dev seed fixture is intentionally small —
one program, one active version, 4 workouts). Fabricating performance
numbers from a toy dataset would be worse than reporting this honestly as
**NOT RUN pending a realistic data volume**. What is verified: every join
used by `PlanReadService` and `workout-command-processing.ts` walks a real
foreign-key/unique index (schema inspection), and Active Workout's
render/timer/draft-write architecture avoids the obvious classes of
mobile performance bugs (full-tree rerender per timer tick, per-keystroke
SQL writes, network in the Complete critical path) by construction, per
the architecture docs' native verification evidence.

## Professional-practice comparison

Matches mature-team practice: transactional idempotency with real race
tests, revision-based conflict resolution instead of LWW, domain/framework
boundary enforcement via tooling (not just review discipline), native
device verification as a release gate rather than trusting emulated/unit
tests, deliberate ADRs for irreversible decisions. Still missing (as
expected at this stage, not a criticism): CI-enforced integration testing
(now fixed), any rate limiting, least-privilege DB roles, and any
externally-facing security process (branch protection, dependency
scanning, pen testing) — all of which require infrastructure that doesn't
exist yet (no hosted deployment, no GitHub remote).

## Beta blockers (P1)

- ~~AUD-008 — rate limiting~~ **RESOLVED** (Security Hardening Follow-Up V1).
- ~~AUD-015 — Postgres least-privilege role separation~~ **RESOLVED**
  (Security Hardening Follow-Up V1).
- ~~AUD-021 — Android backup policy decision~~ **RESOLVED** (Security
  Hardening Follow-Up V1 — tech lead chose "disable entirely").
- AUD-024 — mobile account isolation (tied to real Supabase sign-in,
  already tracked as deferred; re-flag when that work starts). **Still
  open** — full scope expanded in "Production Readiness Backlog" above.
- ~~AUD-041's native re-verification~~ **RESOLVED** (Native Android Sync
  Recovery Re-Verification, 2026-09-09) — proven on a real Android
  emulator with a real process kill, real encrypted SQLite, and a real
  lost-ACK scenario; see "AUD-041 native verification evidence" above.
- AUD-047 — real iOS native runtime verification. **Reclassified here
  from P2, 2026-09-22** — see "Production Readiness Backlog" above for
  full scope and reasoning. **Still open.**
- AUD-027 — permanent Android package identifier / iOS bundle identifier.
  **Reclassified here from P2, 2026-09-22** — see "Production Readiness
  Backlog" above for full scope and reasoning. **Still open.**
- AUD-053 — observability/alerting, AUD-054 — production DB/environment
  verification, AUD-056 — dependency/security recheck, AUD-045 (extended)
  — privacy lifecycle essentials: all new/expanded findings from the
  2026-09-22 Production Readiness Backlog review, see above. **Open.**

## Public release blockers (P2)

- `fastify` CVE resolution once a compatible `@nestjs/platform-fastify`
  release exists — downgraded from an open blocker to a **tracked,
  monitored item**: both advisories are confirmed NOT REACHABLE in
  Vostivo's current configuration (see AUD-028's updated breakdown), so
  this no longer blocks beta; still worth resolving before treating the
  dependency tree as fully clean for public release. Generalized into a
  standing release gate as AUD-056 (see "Production Readiness Backlog"
  above).
- AUD-044 — basic web security headers/robots handling before any real
  content lands on `apps/web`. **Still open** — full scope expanded and
  reclassified to "before paid/public scale" as AUD-060 (see "Production
  Readiness Backlog" above); `apps/web` still carries no real user content.

## NOT RUN / externally dependent

- Hosted Supabase project permission/RLS verification (no hosted project
  exists).
- Real iOS build/runtime verification (this machine cannot build iOS).
- GitHub branch protection, required status checks, Dependabot, secret
  scanning (no git remote configured at all — `git remote -v` is empty).
- Production Postgres backup/restore drill (no production instance
  exists).
- A real penetration test.
- Postgres `EXPLAIN ANALYZE` baseline against realistic production data
  volume.
- Screen-reader (VoiceOver/TalkBack) device-level accessibility pass
  (only code-level review was performed).

## Production Readiness Backlog (Tech-Lead Review, 2026-09-22)

A broad architecture/security/production review, recorded here — the
existing home for release-readiness findings — rather than as a new
planning document. **Nothing below is implemented by this pass.** Every
item is a verification/release-gate requirement, not an architecture
redesign; none of it changes local-first authority, the transactional
outbox, `SyncEngine`, the Postgres ownership model, Supabase's role, the
`pg-boss` choice, the no-Redis-in-V1 rule, the REST/OpenAPI architecture,
privacy/analytics rules, or the EAS deployment strategy — see
"Architecture impact" at the end of this section.

Four phases, used instead of inventing parallel terminology where they
map onto this document's existing severity tiers: **BEFORE BETA** ≈ this
document's existing **P1** ("should block beta"); **BEFORE PAID/PUBLIC
SCALE** is a new, narrower tier than **P2** ("should block public
release") — monetization/scale-triggered, not release-triggered, so it is
named explicitly rather than overloading P2; **DEFERRED UNTIL NATURAL
NEED** ≈ this document's existing "Proposed, not implemented" pattern.

### AUD-053 — Observability / alerting (BEFORE BETA)

No production error monitoring, mobile crash reporting, API error-rate
monitoring, latency monitoring, alert thresholds, release/version
correlation, or a SEV-0 alert path for permanent completed-workout data
loss currently exist. **Existing Sentry/PostHog architectural decisions
remain authoritative** — this is a gap in *actually wiring them up before
release*, not a decision to make. No expansion of sensitive analytics
collection, no sensitive free text in analytics events, and Session
Replay stays off unless separately approved — all already-locked rules,
repeated here only so they aren't relaxed accidentally when this work
starts.

### AUD-054 — Production database/environment readiness (BEFORE BETA)

Extends AUD-046 (backup/recovery, `NOT RUN` — no production instance
exists) with the full verification list needed once a **real managed**
Postgres/Supabase environment exists: runtime-vs-migration role
privileges reproduced against the managed environment (not just local
Docker Postgres — AUD-015's local least-privilege proof is strong but is
not a substitute), private `app` schema / Data API exposure, connection
limits, a connection-pooling strategy, the migration execution identity,
backup/PITR configuration, an actual restore drill (not just
configuration), production indexes/query plans for the critical paths
already identified (`WorkoutHistoryService`, `PlanReadService`), and
proof that a migration was run against staging before it touches
production.

### AUD-055 — Horizontal-scale considerations (BEFORE PAID/PUBLIC SCALE)

Recorded now so it is re-checked before adding API instances, not
implemented now: rate-limit coordination if counters are process-local
(`@fastify/rate-limit`'s current in-memory store, AUD-008), DB connection
budget per instance, `pg-boss` worker ownership/concurrency across
instances, job idempotency, `COMPLETE_SET_V1`/sync-command idempotency
under concurrent API instances (the existing `workout_command_receipts`
durable-idempotency design should already hold here — this item is about
*proving* that under real concurrent instances, not redesigning it), and
confirming no canonical-correctness logic depends on process-local state.
**Do not add Redis now** for this — the no-Redis-in-V1 rule stays locked
until real traffic requires revisiting it.

### AUD-056 — Dependency/security upgrade recheck (BEFORE BETA, recurring release gate)

Generalizes the existing `fastify`/AUD-028 tracking (both current
advisories confirmed NOT REACHABLE) into a standing release gate: re-run
a dependency audit, re-check NestJS/Fastify compatibility, and re-review
security-advisory reachability before every public beta/release. Move to
a compatible patched Nest/Fastify combination when one exists and is
regression-safe — **do not force an incompatible override** to close this
item early.

### AUD-057 — Offline connectivity reconciliation (RESOLVED 2026-10-04)

**Resolved by the Workout Sync Retry Coordinator** — Manual Test #4
(2026-10-04) proved the gap empirically with a backend outage while the
device stayed connected: pending commands stayed local for >60 s after the
API returned, until a background/foreground transition. Sync now also runs
on network regain (`expo-network`) and on a bounded retry backoff
(2/5/10/30 s capped) after any retryable failure. The trigger contract
lives in `docs/architecture/WORKOUT-DATA-INTEGRITY.md` ("When sync runs").
Original (now superseded) assessment, kept for history:

Known, accepted gap: current approved behavior syncs on launch,
foreground/resume, and workout mutations, with durable
PENDING/RETRY/SYNCING recovery (AUD-041). If the app stays foregrounded
while offline and connectivity returns, that offline→online transition
does not itself trigger a sync — the next natural trigger (a mutation,
backgrounding/foregrounding, or relaunch) still does. **Not currently a
correctness/data-loss blocker** — commands remain durable and later sync
opportunities exist — so this is deferred rather than fixed now. When a
central connectivity-awareness layer is later introduced for broader
product needs, hook `SyncEngine` into that signal; do not add a
connectivity-detection dependency solely for this today.

### AUD-024 (extended) — Real mobile authentication / account isolation (BEFORE BETA — unchanged classification)

Already tracked above as "still open." Full beta-gate scope, made
explicit: real Supabase mobile sign-in, account-scoped local DB
lifecycle, logout/login isolation (no user A ever seeing user B's local
workout data), token refresh/expiry behavior, revoked/disabled account
behavior, and removal of the dev-JWT override workflow from release
builds (the existing fail-closed-in-production check, §"Security
baseline" above, must remain enforced, not weakened, when this ships).

### AUD-047 (extended) — iOS native verification (reclassified BEFORE BETA, was P2)

Already tracked above as `NOT RUN`. Full scope, made explicit: SQLCipher,
SecureStore/Keychain behavior, offline workout persistence, process
termination/relaunch, sync recovery, migrations, and notification/
background behavior where applicable. **Reclassified from "Public release
blockers (P2)" to BEFORE BETA** per this 2026-09-22 review — Android
native proof does not stand in for iOS proof, and this project ships both
platforms at beta, not only at public release. The original P2 listing
below is retained for history, cross-referenced rather than deleted.

### AUD-027 (extended) — Release identity (reclassified BEFORE BETA, was P2)

Already tracked above (Android `applicationId` only). Full scope, made
explicit: permanent Android `applicationId` **and** iOS
`bundleIdentifier`, signing ownership, EAS production build profiles,
store metadata ownership, and environment separation (dev/staging/prod
config never cross-contaminating). `com.anonymous.vostivo` remains a
placeholder, not a release identifier. **Reclassified from "Public
release blockers (P2)" to BEFORE BETA** per this 2026-09-22 review, same
reasoning as AUD-047 — this is still explicitly a product/business
decision, not made here.

### AUD-058 — Performance / load testing (BEFORE PAID/PUBLIC SCALE)

Extends "Performance baseline" above (no realistic production-scale
`EXPLAIN ANALYZE` baseline exists yet — correctly `NOT RUN`, not
fabricated). Before public growth, define realistic load tests for: the
workout sync batch endpoint, the bounded history query
(`WorkoutHistoryService`), the login/auth path, Plan read, worker jobs, DB
connection saturation, and API memory/CPU under load. **Measure first,
then optimize** — keep the current bounded-history/index approach
(Progression Prerequisites V1's real `EXPLAIN ANALYZE`-justified indexes),
no speculative caching layer.

### AUD-045 (extended) — Privacy / legal / lifecycle release gates (BEFORE BETA)

Already tracked above (data inventory: PASS, nothing leaks yet; export/
deletion/retention `NOT RUN`, no such feature exists). Existing privacy/
GDPR architecture remains valid and is not redesigned here. Before
release, confirm implementation of: privacy policy, terms, controller/
operator data documentation, consent where required, data export, account
deletion, a retention/deletion workflow, backup-deletion semantics
(documented, not just implied), analytics consent, and store privacy
disclosures. This is a checklist to preserve, not a legal-drafting task.

### AUD-059 — Billing / entitlement (BEFORE PAID/PUBLIC SCALE)

Not implemented, not designed here. Before paid beta/public Pro: the
RevenueCat/store entitlement path, restore-purchases flow, billing
grace/retry semantics, Free→Pro→Free transitions, and two invariants that
must hold from day one of billing design (not bolted on later): **Pro
expiration never deletes workout history**, and logging remains available
per the already-locked Free-tier rules; entitlement state and subscription
state must never be conflated into one field.

### AUD-060 — Website / web release hardening (BEFORE PAID/PUBLIC SCALE, reclassified from P2)

Extends AUD-044 above (currently two placeholder route groups, P3 "harmless
at current placeholder-only state"). Before public website release,
verify: production security headers, robots/noindex boundaries
(auth/staging surfaces noindexed), canonical URLs, a sitemap, structured
data only when truthful, Core Web Vitals, which content is public
SSR/SSG, and the OAI-SearchBot public-content policy per the existing SEO
decision. **Reclassified to BEFORE PAID/PUBLIC SCALE** (later than
AUD-044's original P2 "before public production release" framing) because
`apps/web` currently carries no real user content or forms — hardening it
matters once the site is a real public surface, not before. Website
implementation itself remains out of scope here.

### AUD-061 — Git/repository hygiene (before external handoff / collaborative development)

The current 261-file staged baseline plus substantial unstaged/untracked
work (documented in "Git/index status" below, unchanged by this pass) is
sustainable for solo continuation but must be resolved before: external
interview/demo handoff, collaborative development, a public repository,
or serious beta-release process work. **Explicitly deferred by the user's
own instruction — not fixed in this task, and must not be fixed
incidentally by a future task either, without being asked.** Recorded
here so it does not silently disappear from the project plan. A future
dedicated task should establish a clean, reviewable commit
history/checkpoint without losing any current work — a `git`-safety-
sensitive task in its own right, not a side effect of an unrelated change.

### Priority classification (grouping the IDs above)

**NOW:** RANGE precedence fix (this task, Part A — see "RANGE precedence
fix" in the final report) · continue Progression product work only after
explicit Slice-C approval.

**BEFORE BETA:** AUD-024 (real mobile auth/account isolation) · AUD-054
(production DB/environment verification) · AUD-053 (observability/
alerting) · AUD-047 (iOS native proof) · AUD-027 (permanent app IDs) ·
AUD-056 (dependency/security recheck) · AUD-045 (privacy lifecycle
essentials) · release infrastructure generally.

**BEFORE PAID/PUBLIC SCALE:** AUD-059 (billing/entitlements) · AUD-055
(horizontal-scale/rate-limit strategy if multi-instance) · AUD-058 (load
testing) · broader operational scaling work · AUD-060 (website full
release hardening).

**DEFERRED UNTIL NATURAL NEED:** AUD-057 (central connectivity signal for
online transition) · Redis/distributed infrastructure · speculative
caches.

**Not classified above (its own gate, not a phase):** AUD-061 (Git
repository hygiene) — before external handoff/collaborative development,
independent of the beta/public-scale timeline.

### Architecture impact: NONE

This backlog does not change: local-first authority, the transactional
outbox pattern, `SyncEngine`, the Postgres ownership model, Supabase's
role in the architecture, the `pg-boss` choice, the no-Redis-in-V1 rule,
the REST/OpenAPI architecture, privacy/analytics rules, or the EAS
deployment strategy. Two items above are **reclassifications of existing
findings' priority tier** (AUD-027, AUD-047, AUD-060 — moved earlier or
later in the release timeline), not changes to what those findings say.
No finding in this review conflicts with an existing locked architecture
decision; if one is later found to, it must be reported separately, not
folded into this list.

## Regression results

Original audit pass, then re-run after the Security Hardening Follow-Up V1:

| Check | Original audit | Follow-up pass |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | PASS |
| `pnpm lint` | PASS (16/16 tasks) | PASS (16/16 tasks) |
| `pnpm typecheck` | PASS (16/16 tasks) | PASS (16/16 tasks) |
| `pnpm test` (unit) | PASS — 94 tests (mobile 53, database 21, api 20) | PASS — 102 tests (mobile 53, database 21, api 28 — +8 for rate-limit/api-config) |
| `pnpm build` | PASS (10/10 tasks) | PASS (10/10 tasks) |
| `pnpm boundaries:check` | PASS — 262 modules, 572 dependencies | PASS — 270 modules, 590 dependencies, zero violations |
| `pnpm db:migrate` (migration/admin role) | N/A (role split didn't exist yet) | PASS — real local Postgres |
| `pnpm db:bootstrap-roles` (idempotent) | N/A | PASS — run twice; second run correctly detected "already existed" |
| Real-Postgres integration tests (`apps/api test:integration`) | PASS — 3 files, 32 tests | PASS — 4 files, **38 tests** (+6 `db-privilege.integration.test.ts`), using the least-privilege runtime role by default |
| Real PostgreSQL privilege-denial proof (DDL/CREATE ROLE) | N/A | PASS — real SQLSTATE `42501` on CREATE TABLE, DROP TABLE, ALTER TABLE, CREATE ROLE against `vostivo_api`; ordinary SELECT/INSERT still succeed |
| Rate-limit behavioral tests (real Fastify request cycle) | N/A | PASS — 4 tests: allowed, 429 with safe body + `Retry-After`, window recovery, sustained normal use |
| Expo Doctor | 19/21 — 2 known/classified warnings | 19/21 — same 2 warnings, unchanged in nature (Metro symlink override intentional; expo/expo-router routine patch drift) |
| Expo config / prebuild verification of `allowBackup` | N/A | PASS — `expo config --type public` and a temporary `expo prebuild` both confirm `allowBackup=false` reaches the real generated manifest; generated `android/` removed afterward |
| Security negative tests (BOLA, idempotency, revision gating) | PASS — existing suite | PASS — existing suite, still green, now also wired into CI |
| Native Android re-verification of the AUD-041 `SYNCING` fix | NOT RUN | NOT RUN in that pass — **PASS**, done in the dedicated Native Android Sync Recovery Re-Verification pass (2026-09-09): real process kill, real encrypted SQLite, real lost-ACK, real Finish-causal-boundary smoke check — see "AUD-041 native verification evidence" |

## Files changed

**Native Android Sync Recovery Re-Verification (2026-09-09):** no net
source change — two temporary diagnostics (an env-gated delay in
`workout-sync-api-client.ts`, a new `dev-sync-verify.tsx` screen) were
added, used to gather the evidence above, then fully removed;
`git diff` on every touched source file is empty (confirmed via
`turbo`'s cache-hit on lint/typecheck/test after cleanup). Only this
audit document and `CLAUDE.md` were durably updated.

**Original audit — safe remediations:**
- `apps/api/src/workout/dto/workout-command.dto.ts` — sync batch size bound
- `apps/api/src/main.ts` — Swagger/docs production gating
- `.github/workflows/ci.yml` — Postgres service + integration test step
- `apps/mobile/src/workout/workout-repository.ts` — stranded-`SYNCING` fix

**Security Hardening Follow-Up V1 — Postgres least privilege:**
- `packages/database/src/bootstrap-roles.ts` — new; idempotent least-
  privilege role bootstrap
- `packages/database/src/config.ts` — new `MIGRATION_DATABASE_URL`
  schema/loader alongside the existing `DATABASE_URL` one
- `packages/database/src/migrate.ts` — now uses the migration/admin role
- `packages/database/drizzle.config.ts` — now uses `MIGRATION_DATABASE_URL`
- `packages/database/package.json` — new `db:bootstrap-roles` script
- `packages/database/.env.example` — documents both roles + the bootstrap
  password variable
- `package.json` (root) — new `db:bootstrap-roles` forwarding script
- `apps/api/.env.example` — `DATABASE_URL` now points at the runtime role;
  new rate-limit env vars documented
- `apps/api/src/database/db-privilege.integration.test.ts` — new; 6 tests
  proving real permission denial
- `apps/api/src/auth/identity-resolution.integration.test.ts`,
  `apps/api/src/plan/plan.integration.test.ts`,
  `apps/api/src/workout/workout-sync.integration.test.ts` — default
  connection string switched to the runtime role
- `.github/workflows/ci.yml` — added `MIGRATION_DATABASE_URL`/
  `VOSTIVO_API_DB_PASSWORD` env + a "Bootstrap least-privilege DB role" step

**Security Hardening Follow-Up V1 — API rate limiting:**
- `apps/api/package.json` — new `@fastify/rate-limit` dependency
- `apps/api/src/common/rate-limit.ts` — new; registration + reasoning
- `apps/api/src/common/rate-limit.test.ts` — new; 4 real-request-cycle tests
- `apps/api/src/common/config/api-config.ts` — new `RATE_LIMIT_MAX`,
  `RATE_LIMIT_WINDOW_SECONDS`, `TRUST_PROXY`
- `apps/api/src/common/config/api-config.test.ts` — new; 4 tests
- `apps/api/src/main.ts` — `trustProxy` wired into `FastifyAdapter`,
  rate limiter registered after helmet

**Security Hardening Follow-Up V1 — Android backup:**
- `apps/mobile/app.json` — `android.allowBackup: false`
- `docs/architecture/FOUNDATION.md` — decision/rationale/recovery-model
  documented

**Documentation:**
- `docs/audits/V1-ENGINEERING-SECURITY-BASELINE.md` — edited in place with
  the follow-up's findings (not duplicated)
- `CLAUDE.md` — updated with the follow-up's locked decisions (see diff)

**Investigated, not changed:**
- `fastify`/`@nestjs/platform-fastify` — re-confirmed no safe upgrade path
  exists (exact-pinned transitive dependency, no newer compatible NestJS
  release); both advisories independently confirmed NOT REACHABLE — see
  AUD-028. No dependency version was changed.

## Git/index status

The original 261-file baseline commit (from the "First Verified Git
Checkpoint" task) remains **staged, untouched, and uncommitted** — it was
never committed because Git author identity is still not configured on
this machine, and neither the original audit nor this follow-up touched
the index. Every change from both passes exists only as **unstaged
working-tree modifications** (18 modified files) plus **untracked new
files** (6 new files under `apps/api/src/`, `packages/database/src/`, and
`docs/audits/`) on top of that stage:

```
$ git diff --cached --stat | tail -1
 261 files changed, 35222 insertions(+)          # unchanged, still staged

$ git status --porcelain | grep '^A ' | wc -l
261                                                # staged baseline, untouched

$ git status --porcelain | grep -v '^A '
AM .github/workflows/ci.yml
AM CLAUDE.md
AM apps/api/.env.example
AM apps/api/package.json
AM apps/api/src/auth/identity-resolution.integration.test.ts
AM apps/api/src/common/config/api-config.ts
AM apps/api/src/main.ts
AM apps/api/src/plan/plan.integration.test.ts
AM apps/api/src/workout/dto/workout-command.dto.ts
AM apps/api/src/workout/workout-sync.integration.test.ts
AM apps/mobile/app.json
AM apps/mobile/src/workout/workout-repository.ts
AM docs/architecture/FOUNDATION.md
AM package.json
AM packages/database/.env.example
AM packages/database/drizzle.config.ts
AM packages/database/package.json
AM packages/database/src/config.ts
AM packages/database/src/migrate.ts
AM pnpm-lock.yaml
?? apps/api/src/common/config/api-config.test.ts
?? apps/api/src/common/rate-limit.test.ts
?? apps/api/src/common/rate-limit.ts
?? apps/api/src/database/db-privilege.integration.test.ts
?? docs/audits/
?? packages/database/src/bootstrap-roles.ts
```

(`AM` = staged as Added from the original checkpoint, since Modified in
the working tree; `??` = new, untracked.) No `git add`, `commit`, `reset`,
`restore --staged`, or `push` was performed at any point across any of
the three tasks. `git remote -v` is empty — there is no remote configured.

**Re-verified identical after the Native Android Sync Recovery
Re-Verification pass** — that task's two temporary diagnostics were
fully removed (net-zero source diff), so the staged/unstaged/untracked
state above is exactly unchanged, plus this document and `CLAUDE.md`
being edited (already `AM` above).

## Language used in this document

Nothing here is a claim that Vostivo "is ASVS compliant," "is MASVS
compliant," or "is secure." Every PASS above means **locally verified
against this codebase, at this point in time, by direct code
inspection and/or a real test run** — mapped against the referenced
standard's relevant control, never a certification of that standard.

## Recommended next task

With rate limiting, Postgres least privilege, Android backup, and the
AUD-041 native sync-recovery proof all resolved, there are no remaining
P0/P1 engineering-*quality* findings blocking beta from the original
audit. **Superseded by the 2026-09-22 Production Readiness Backlog
above**: real iOS native verification (AUD-047) and permanent release
identifiers (AUD-027) are now explicitly reclassified as **BEFORE BETA**,
not pre-release-only items — see that section for the corrected
reasoning and the full BEFORE BETA list (also including AUD-024 real
mobile auth, AUD-054 production DB/environment verification, AUD-053
observability/alerting, AUD-056 dependency recheck, and AUD-045 privacy
lifecycle essentials). The recommended next step remains to resume normal
product feature work per the next tech-lead-assigned slice; the BEFORE
BETA backlog items require their own dedicated infrastructure/decisions,
not incidental follow-up work, and none of them block continuing
Progression Engine product work today. Do not start a new feature without
explicit direction.

---

Vostivo Engineering Quality & Security Baseline Audit — updated by the
Security Hardening Follow-Up V1 pass, the Native Android Sync Recovery
Re-Verification pass, and the 2026-09-22 Production Readiness Backlog
review.
Awaiting tech-lead review.
