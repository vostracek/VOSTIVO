# Development setup

## Prerequisites

- **Node.js 24.20.x LTS** — pinned in `.nvmrc`; run `nvm use` in the repo
  root to select it (does not touch your global/system Node, which may be a
  different version shared with unrelated projects on this machine).
  `engines.node` in the root `package.json` enforces `>=24.20.0 <25.0.0`,
  and CI (`.github/workflows/ci.yml`) pins the same `24.20.0`.
- **pnpm 11.25.0** — pinned via the root `packageManager` field; enable with
  `corepack enable && corepack prepare pnpm@11.25.0 --activate`.
- **Docker** (optional, for local Postgres) — or point `DATABASE_URL` at
  any Postgres 17+ instance you already have.
- **Expo tooling** for mobile: the local database is SQLCipher-encrypted
  (`useSQLCipher: true` in `apps/mobile/app.json`), which requires a native
  development build — **Expo Go cannot run this app** (it can't load the
  SQLCipher-compiled native module). Use `pnpm --filter @vostivo/mobile android`
  / `... ios` (runs `expo run:android` / `expo run:ios`), not `expo start`
  in Expo Go. See `docs/architecture/FOUNDATION.md` for details and current
  verification status.

## Install

```bash
pnpm install --frozen-lockfile
```

## Environment files

Every app/package that needs config ships a `.env.example`. Copy it to
`.env` and fill in local values — never commit a real `.env`.

```bash
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp packages/database/.env.example packages/database/.env
cp apps/mobile/.env.example apps/mobile/.env
```

`apps/api/.env` needs `SUPABASE_URL` (your Supabase project's base URL) —
used only to derive the JWKS endpoint and expected issuer for JWT
verification; no secret/service-role key is ever read by the API. See
`docs/architecture/IDENTITY-AUTH.md`.

## Local Postgres

```bash
docker compose up -d postgres
pnpm db:generate   # only after changing packages/database/src/schema
pnpm db:migrate    # applies pending migrations to DATABASE_URL
```

## Running things

```bash
pnpm --filter @vostivo/api dev       # NestJS API on :4000 (health at /health/live)
pnpm --filter @vostivo/worker dev    # background worker process
pnpm --filter @vostivo/web dev       # Next.js on :3000
pnpm --filter @vostivo/mobile android  # builds + runs a native dev build (required — Expo Go can't load SQLCipher)
pnpm --filter @vostivo/mobile ios      # same, for iOS (macOS only)
```

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm boundaries:check   # architectural dependency rules (packages/domain, packages/training-engine)
pnpm --filter @vostivo/api test:integration  # identity-resolution tests against real local Postgres
```

## Manual end-to-end smoke testing (LOCAL ONLY)

A separate, deliberately isolated database and auth path exist purely for
running the real backend + a real mobile client by hand — never used by
`pnpm test`/CI, never pointed at any hosted/production service.

### `vostivo_manual` — the manual-smoke-test database

Running the API/worker against your everyday `vostivo_dev` database works,
but `vostivo_dev` accumulates integration-test residue (stale users,
pg-boss jobs) over time, which is noisy for a human watching logs during a
manual walkthrough. `vostivo_manual` is a second, separate database in the
same local Postgres container, reserved for this.

```bash
# packages/database/.env needs MANUAL_DATABASE_URL set (see .env.example) —
# the migration/admin role, targeting .../vostivo_manual specifically.
pnpm --filter @vostivo/database db:manual:reset
```

This **drops and recreates** `vostivo_manual` from scratch, then applies
every migration, grants the least-privilege `vostivo_api` role, and
bootstraps pg-boss — all in one idempotent command
(`packages/database/src/bootstrap-manual-db.ts`). It hard-refuses to run
unless `NODE_ENV=local`, the target host is local, and the database name
is **exactly** `vostivo_manual` — it can never touch `vostivo_dev` or any
other database, by construction (see `assertSafeManualDbTarget` and its
tests). Point `apps/api/.env` and `apps/worker/.env`'s `DATABASE_URL` at
`vostivo_manual` (not `vostivo_dev`) when running a manual session.

### Local JWT auth (no real Supabase project needed)

The real API verifies JWTs against a real JWKS — normally Supabase's own
published one (`SUPABASE_URL`). For local manual testing, a local
asymmetric keypair stands in instead, verified through the exact same
`jose`/`SupabaseJwtVerifier` code path real tokens go through — this is
**not** an auth bypass; an invalid/unsigned/wrong-issuer token is still
rejected.

```bash
# One-time (or after deleting apps/api/.local/) — generates a local
# ES256 keypair + public JWKS under apps/api/.local/ (git-ignored by the
# repo's own *.local rule — never commit this directory).
pnpm --filter @vostivo/api auth:local:generate-key

# apps/api/.env then needs:
#   NODE_ENV=local
#   LOCAL_JWKS_PATH=<absolute path to apps/api/.local/jwks.json>
#   SUPABASE_URL=<any well-formed https:// URL — never dereferenced over
#                 the network while LOCAL_JWKS_PATH is set; it only
#                 supplies the token's expected issuer string>
# LOCAL_JWKS_PATH fails config validation outside NODE_ENV=local — it can
# never silently activate in development/staging/production.

# Mint a short-lived (24h default) signed dev athlete JWT:
SUPABASE_URL=<same value as apps/api/.env> pnpm --filter @vostivo/api auth:local:mint-jwt
```

The minted token goes on **stdout only** (every human-readable message is
on stderr), so `TOKEN=$(SUPABASE_URL=... pnpm --filter @vostivo/api auth:local:mint-jwt 2>/dev/null)`
captures just the token. Re-run the mint command to get a fresh one once
it expires — nothing here is a long-lived credential.

On the mobile side, the existing `apps/mobile/.env` dev override consumes
the same token:

```bash
EXPO_PUBLIC_VOSTIVO_ENV=local
EXPO_PUBLIC_DEV_JWT=<the minted token>
```

(`createPlanAuthTokenProvider`, `apps/mobile/src/infrastructure/plan-runtime-config.ts`
— fails closed to a real Supabase sign-in flow if `EXPO_PUBLIC_VOSTIVO_ENV`
isn't `local`.)

### Starting the backend against `vostivo_manual`

```bash
pnpm --filter @vostivo/api dev       # DATABASE_URL + LOCAL_JWKS_PATH point at vostivo_manual's setup above
pnpm --filter @vostivo/worker dev    # DATABASE_URL points at vostivo_manual too
```

### Manual fixture data

```bash
# 1. Create the athlete profile via the REAL authenticated identity path
#    (never inserted directly) — any authenticated call works, e.g.:
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/me
# Note the returned athleteProfileId.

# 2. Seed a deterministic active Plan for that athlete (also sets
#    experienceMode — no product API changes athlete mode, so this is the
#    DEV-ONLY path to do it for a manual test — and the athlete's IANA
#    training time zone, TRAINING_TIME_ZONE, default Europe/Prague; the
#    Missed Workout preview returns 409 TRAINING_TIME_ZONE_REQUIRED without
#    one):
ATHLETE_PROFILE_ID=<id> EXPERIENCE_MODE=ADAPTIVE DATABASE_URL=<vostivo_manual runtime URL> \
  pnpm --filter @vostivo/database db:seed:dev-plan
#    Missed Workout human test: add MISSED_WORKOUT_FIXTURE=true (and
#    SMALL_FIXTURE=true for a short, Adjust-time-ready Upper Body A) — the
#    current cycle then starts two athlete-local days before today, so
#    Upper Body A is exactly one missed workout and Lower Body A is today.
#    Temporary Equipment human test: EQUIPMENT_ADAPTATION_FIXTURE=true
#    instead (not together with MISSED_WORKOUT_FIXTURE) — Upper Body A =
#    Bench Press 3 x 8-12 + Overhead Press 2 x 8-12 on the athlete-LOCAL
#    today (implies SMALL_FIXTURE), GUIDED unless EXPERIENCE_MODE is set,
#    nothing started. Declaring dumbbells + flat bench + adjustable bench
#    (no barbell / rack) previews Bench -> Dumbbell Bench Press and OHP ->
#    Seated Dumbbell Overhead Press. Requires migration 0020 on
#    vostivo_manual (`MIGRATION_DATABASE_URL=<vostivo_manual admin URL>
#    pnpm --filter @vostivo/database db:migrate`, or a full
#    `db:manual:reset`, which wipes the manual database).
#    Full athlete journey (progression visible on the next exposure): add
#    ATHLETE_JOURNEY_FIXTURE=true to EQUIPMENT_ADAPTATION_FIXTURE=true — the
#    same four workouts are also seeded in the NEXT cycle (+7 days, same
#    order), then bind bench-press below. Completing all Bench Press working
#    sets at 12 reps yields INCREASE_LOAD; GUIDED auto-applies it (worker
#    must run) and next week's Upper Body A previews 62.5 kg.

# 3. Bind a valid Loading Capability to one exercise, so Progression
#    Apply doesn't first require Guided Setup recovery:
ATHLETE_PROFILE_ID=<id> EXERCISE_REF=bench-press INCREMENT_KG=2.5 \
  DATABASE_URL=<vostivo_manual runtime URL> \
  pnpm --filter @vostivo/api dev:seed-loading-capability
```
