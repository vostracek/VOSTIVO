# Vostivo — Plan & Workout Prescription Vertical Slice

Scope: the first user-facing product slice. Answers "Kam můj trénink
směřuje?" (Where is my training headed?) — Current Block → current
Cycle → this week's sessions → Weekly Focus → Workout Preview → the
already-existing `WorkoutPrescriptionV1` → the already-existing
`startWorkoutSession()`. No polished Active Workout logger, no
Progression/Adaptation Engine, no Athlete Memory, no Coach Web, no
billing, no complete Expert program builder, no arbitrary calendar
planning. See `CLAUDE.md` for what this slice deliberately excludes.

## Program hierarchy

```text
Program            long-lived logical program, owned by athleteProfileId
  -> ProgramVersion   effectively immutable once ACTIVE; a structural
                       change would create a new version (not implemented
                       — this slice only implements the data model and
                       the invariant)
    -> TrainingBlock    the current mesocycle; goal, cycleCount, a small
                         labeled Weekly Focus list (name + PRIORITY/
                         MAINTAIN, never a computed volume model)
      -> TrainingCycle    the structural week/cycle unit — real
                           [startDate, endDate], never assumed to be an
                           ISO Monday-Sunday week
        -> PlannedWorkout   scheduling status ONLY (see below)
          -> PlannedExercise  exerciseRef stays opaque/unresolved (no
                               Exercise Taxonomy yet, same boundary as
                               WDI's PrescribedExerciseV1)
            -> PlannedSet       target is Intent — a RepTargetV1
                                 (EXACT or RANGE) + Load Model Stage 1 +
                                 an optional restSeconds (Active Workout
                                 Core Logger V1), never Reality
```

No performed-workout history lives here — that stays exclusively in
Workout Data Integrity's `WorkoutSession`/`PerformedExercise`/
`PerformedSet`, which this slice never mutates.

### `ProgramVersion` immutability, without a circular pointer

"The active version" is derived from `ProgramVersion.status = 'ACTIVE'`,
not a denormalized `Program.activeProgramVersionId` column — a
`UNIQUE INDEX ... WHERE status = 'ACTIVE'` (`packages/database/src/schema/plan.ts`)
enforces "at most one active version per program" at the database level.
This also avoids a circular foreign key between `programs` and
`program_versions`. See ADR-0008.

### `PlannedWorkout` never owns execution truth

A previously locked correction, preserved here: `PlannedWorkout.status`
is scheduling/planning only (`PLANNED`, `AVAILABLE`, `SKIPPED`,
`RESCHEDULED`, `CANCELLED`) — never `STARTED`/`COMPLETED`. A displayed
"Completed"/"In progress" state is *derived* by joining against a real
`WorkoutSession` (`deriveSessionDisplayStatus`,
`packages/domain/src/plan/session-status-projection.ts`); it is never
written back onto the `PlannedWorkout` row.

**Resolved by Active Workout Core Logger V1**: Workout Data Integrity now
has a real "finish workout" operation (`FINISH_WORKOUT_SESSION_V1` — see
`docs/architecture/ACTIVE-WORKOUT.md` and ADR-0007's "Extension"
section), so `COMPLETED` is reachable in practice, not just in a
constructed test fixture. Exactly as anticipated when this projection
function was first written: nothing here needed to change — the same
`deriveSessionDisplayStatus` logic that was already tested against a
constructed `COMPLETED` session now also handles real completed sessions
correctly.

## Rest days

Rest days have no backing `PlannedWorkout` row. The read model
(`PlanReadService.getCurrentPlanOverview` ->
`interleaveRestDays`) synthesizes a `REST` entry for every date in the
current cycle's `[startDate, endDate]` range with nothing scheduled —
explicit, but visually secondary in the UI.

## Deliberate deferrals (reported, not silently decided)

- **Planned RIR target**: not implemented. No numeric RIR range/policy is
  specified anywhere in the approved Training Engine spec
  (`packages/training-engine`) to implement against, and `PerformedSet`
  already established the precedent of omitting RIR entirely rather than
  inventing that policy. Report: deferred, matching precedent.
- **`PlannedExercise.priorityTier` / `minimumWorkingSets`** (Available-Time
  Adaptation V1 Slice B): implemented as authored program structure,
  nullable for database compatibility only (NULL = "not authored", which is
  never defaulted). A workout with any NULL is not eligible for an
  available-time preview. See `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md` §17.
- **`PlannedExercise.role`** (primary/accessory/etc.): not implemented —
  no exercise-role vocabulary is specified anywhere in the approved
  domain model.
- **Exercise Taxonomy**: `exerciseRef` stays an opaque, unresolved
  pointer, same boundary as WDI.

## `RepTargetV1` — the one rep-target representation (resolved, was a reported conflict)

**Resolved by the Plan Contract Integrity Fix Pass.** The original
implementation mapped a `PlannedSet` rep range down to
`PrescribedSetV1.targetReps: number | null` (its minimum) — a real,
lossy information loss that discarded the upper bound of the athlete's
prescribed range in an artifact (`WorkoutPrescriptionV1`) whose entire
purpose is to be the immutable snapshot of Plan intent. That was rejected
on review as unacceptable.

The fix: `RepTargetV1` (`packages/domain/src/rep-target.ts`) —

```ts
type RepTargetV1 =
  | { kind: "EXACT"; reps: number }
  | { kind: "RANGE"; minReps: number; maxReps: number };
```

— is now the single authoritative rep-target representation, used
identically by `PlannedSet.targetReps`, `PrescribedSetV1.targetReps`
(Workout Data Integrity, ADR-0007), and `WorkoutPreviewSetV1.targetReps`
(the wire DTO). There is exactly one field carrying this concept in each
type — never a parallel min/max pair alongside it.

**Compatibility check performed before changing the WDI contract**
(per the task's instruction to inspect consumers first): `WorkoutPrescriptionV1`
is only ever persisted as an opaque JSON blob
(`app.workout_sessions.prescription_snapshot`, mobile's
`local_workout_sessions.prescription_json`) — no structured column
anywhere depends on `targetReps`'s exact shape, no production users
exist, and the contract was never publicly released. No genuine
compatibility blocker was found, so the correction was made in place —
no `WorkoutPrescriptionV1` V2 was introduced.

Physical storage is unchanged: `planned_sets.target_reps_min`/
`target_reps_max` remain two nullable integer columns (no migration was
needed). `repTargetFromRange`/`repTargetToRange`
(`packages/domain/src/rep-target.ts`) are the only place that
reinterpretation happens — equal bounds collapse to `EXACT`, unequal
bounds become `RANGE`, both `null` means no target.

## Server schema

`app.programs`, `app.program_versions`, `app.training_blocks`,
`app.training_cycles`, `app.planned_workouts`, `app.planned_exercises`,
`app.planned_sets` (`packages/database/src/schema/plan.ts`). Real
PostgreSQL constraints, not just application discipline:

```text
programs               FK -> athlete_profiles, no active-version pointer
program_versions        UNIQUE(program_id, version_number)
                         UNIQUE(program_id) WHERE status = 'ACTIVE'
training_blocks         UNIQUE(program_version_id, order_index)
training_cycles          UNIQUE(training_block_id, order_index)
                          CHECK end_date >= start_date
planned_workouts          UNIQUE(training_cycle_id, order_index)
planned_exercises          UNIQUE(planned_workout_id, order_index)
planned_sets                 UNIQUE(planned_exercise_id, order_index)
                              CHECK load columns all-null or all-not-null
```

All foreign keys are `NO ACTION` (never `CASCADE`) — matching the rest of
the schema; historical `ProgramVersion` reconstructability must never
depend on an accidental cascading delete.

## Dev seed fixture

`packages/database/src/seed-dev-plan.ts` (`pnpm db:seed:dev-plan`, needs
`ATHLETE_PROFILE_ID`) — **not** production demo-data architecture, and
never imported by production UI or application code. Idempotent: wipes
and recreates the exact same fixture for the given athlete. One
Upper/Lower hypertrophy program, one active version, one 6-cycle block,
with only the *current* cycle (the one containing "today," computed
relative to the machine's clock at seed time) populated with 4 realistic
workout days — kept intentionally small.

## Plan read model

`PlanReadService` (`apps/api/src/plan/plan-read.service.ts`) builds
`PlanOverviewV1`/`WorkoutPreviewV1` (`packages/contracts`) directly from
the relational graph — the mobile client never reconstructs
Program/ProgramVersion/TrainingBlock/TrainingCycle/PlannedWorkout itself,
and these are never serialized ORM rows (verified directly:
`PLAN-API-003`).

```text
GET /api/v1/plan/current                    -> PlanOverviewV1
GET /api/v1/plan/workouts/:plannedWorkoutId -> WorkoutPreviewV1
```

**Effective schedule (Missed Workout V1 Slice C):**
- Session dates and `TODAY` come from the block's EFFECTIVE schedule:
  authored `scheduled_date`, overridden only by the athlete's ACTIVE
  missed-workout schedule overlay.
- The authored date is never mutated. It is exposed alongside as
  `authoredScheduledDate`, with `scheduleSource` set to `AUTHORED` or
  `ADAPTED`.
- A rolled-forward workout appears in the cycle containing its effective
  date, even when it was authored in an earlier cycle.
- A carryover (still owed, with no known slot) appears with
  `scheduledDate: null`.

See `docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md` §10 and
`docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md`.

Ownership always derives from `AuthenticatedActor.athleteProfileId`,
never a request parameter — a workout that exists but belongs to another
athlete returns the same "not found" as one that does not exist at all
(no existence leakage, `PLAN-API-002`).

## `WorkoutPrescriptionV1` transformation and the WDI handoff

`WorkoutPreviewV1.prescription` is the already-built
`WorkoutPrescriptionV1` for that planned workout
(`createWorkoutPrescriptionFromPlannedWorkout`,
`packages/domain/src/plan/prescription-builder.ts`) — built once,
server-side, at the same time as the rest of the preview. Every id in the
result is the corresponding planned entity's own stable id
(`prescriptionId = plannedWorkoutId`, etc.), never freshly minted, so
repeated calls for the same planned workout produce identical ids
(`PLAN-004`).

The mobile Start Workout action passes `preview.prescription` **directly**
to WDI's real `startWorkoutSession()` — no second network call at
Start-tap time, and no second, parallel prescription-mapping
implementation on the client (spec section 23's "do not silently fork
prescription representations"). This is also why Active Workout does not
need network once the athlete has opened Preview: the prescription is
already resolved and held in the screen's own state.

Every field, including `targetReps` (`RepTargetV1` — see above), is
carried through losslessly — a `RANGE` stays a `RANGE` end to end:
server read model -> `WorkoutPreviewV1` -> mobile Start Workout ->
`WorkoutSession.prescription_snapshot`, verified natively across a real
offline force-stop/relaunch (see "Native Android verification").

`PLAN-005` (a later Plan edit cannot change an already-created
`WorkoutSession`'s snapshot) is proven twice: a pure-function proof in
`packages/domain/src/plan/plan.test.ts`, and a real-Postgres proof in
`apps/api/src/plan/plan.integration.test.ts` — start a session with a
resolved prescription, `UPDATE` the source `planned_sets` row, re-select
the session, confirm its stored `prescription_snapshot` is byte-identical
to before.

## Mobile architecture

```text
apps/mobile/src/plan/plan-api-client.ts            the one place Plan
                                                    HTTP calls happen
apps/mobile/src/plan/plan-application-service.ts   the single boundary
                                                    Plan/Preview/(future)
                                                    Today screens call —
                                                    no screen talks to
                                                    PlanApiClient or WDI
                                                    directly
apps/mobile/src/plan/plan-runtime.ts               composition root:
                                                    constructs the
                                                    WorkoutRepository/
                                                    SyncEngine/
                                                    WorkoutApplicationService
                                                    /PlanApplicationService
                                                    graph once
apps/mobile/src/infrastructure/plan-runtime-config.ts
                                                    auth token + API base
                                                    URL wiring (see below)
```

`PlanApplicationService.startWorkout` delegates straight to WDI's
`WorkoutApplicationService.startWorkoutSession` — it does not re-implement
the "is there already an active session" check; WDI's own single-local-
active-session guard is what prevents a duplicate (`PLAN-MOB-004`,
verified natively: tapping Start Workout twice on the same planned
workout, once online and once again after a full offline force-stop/
relaunch, produced the identical `WorkoutSession` id both times).

React state is ephemeral UI-interaction state only. Canonical Plan data
comes from the server/read projection; canonical active-workout runtime
comes from encrypted SQLite via WDI. The Plan screen's active-session
check (`getActiveWorkoutSession`) is fetched **independently** of the
Plan overview fetch specifically so that a Plan network failure (see
"Offline boundary" below) never hides a real, locally-available Resume
path — verified natively (see "Native verification").

### Auth wiring — no production bypass, hardened by the Plan Contract Integrity Fix Pass

Production Supabase mobile sign-in is still deferred
(`docs/architecture/IDENTITY-AUTH.md`). `createPlanAuthTokenProvider()`
(`apps/mobile/src/infrastructure/plan-runtime-config.ts`) resolves to
`DeferredSupabaseAuthTokenProvider` (throws loudly) unless the dev
override is explicitly, doubly opted into. **Two independent conditions**
must both hold for `StaticTestAuthTokenProvider` to activate:

```text
EXPO_PUBLIC_VOSTIVO_ENV   set to something other than "production"
                          (reusing packages/config's LOCAL/DEVELOPMENT/
                          STAGING/PRODUCTION model, not a second
                          taxonomy) — unset or unrecognized fails CLOSED
                          to "production"
EXPO_PUBLIC_DEV_JWT       set to a real token
```

If `EXPO_PUBLIC_DEV_JWT` is present while the resolved environment is
`production` — e.g. a build pipeline sets the token but forgets to also
flip the environment — `createPlanAuthTokenProvider()` throws immediately
rather than silently granting access. Neither variable is ever committed;
`EXPO_PUBLIC_DEV_JWT` only ever comes from a developer's gitignored
`.env.local`, and no real build/release pipeline sets it. No
authentication-bypass endpoint exists server-side. See
`plan-runtime-config.test.ts` for the regression tests proving all of
this (production + override configured is rejected; unset environment
fails closed; an unrecognized environment value fails closed; the
override activates only with both conditions explicit).

This is deliberately **not** also gated on `__DEV__`: the mandatory
native offline verification for this project always uses a release build
(embedded JS, no Metro dependency at runtime), and a release build always
has `__DEV__ === false` — gating on it would make the override impossible
to exercise in exactly the variant that needs it. (The original `__DEV__`
gate was a real bug found and fixed during the Plan slice's first native
verification; the environment-based hardening above was added in the
follow-up fix pass after a second review specifically asked for a
structural, not just incidental, guard against this override reaching a
real production build.)

## Offline boundary — stated honestly

Plan (`GET /plan/current`, `GET /plan/workouts/:id`) requires network in
this slice — there is no Plan cache/sync protocol. This is a deliberate,
documented scope boundary (spec section 35), not an oversight. What *is*
offline, and verified natively:

- Once a `WorkoutPreviewV1` has been fetched, tapping Start Workout needs
  no further network call — the prescription is already held locally.
- The resulting `WorkoutSession` write and its later Resume-detection
  both hit only encrypted local SQLite via WDI.
- The Plan screen's Resume banner (`hasActiveSessionAnywhere`) is fetched
  independently of the Plan overview and survives a Plan-fetch failure.

## Mobile UI

Premium Performance / Refined Dark. **Honest gap**: no design-token
source of truth or asset file (palette beyond the one locked brand
color, type scale, Archivo font files) existed anywhere in this
repository before this slice. `apps/mobile/src/design/tokens.ts` is a
new, minimal, conservative token set built from that single locked
decision (`#CDF24E` = active/current/focus, never generic success) plus
restrained dark-UI defaults — not a recreation of a design file this repo
does not have. Typography uses the OS system font; no bundled Archivo
file exists to load via `expo-font`. A tech-lead-supplied token source
should replace this file wholesale when available.

```text
app/index.tsx                    Plan screen — Current Block, This Week
                                  (with synthesized rest days), Weekly
                                  Focus, persistent bottom nav
app/workout/[plannedWorkoutId].tsx  Workout Preview — purpose, exercises,
                                     sets/rep ranges, load, duration,
                                     Start Workout
app/active-workout.tsx           TEMPORARY minimal placeholder — reads
                                  the REAL active WorkoutSession from WDI;
                                  the polished Active Workout logger is a
                                  separate, not-yet-started slice
src/ui/bottom-nav.tsx            Today/Progress/Profile are visible but
                                  explicitly non-interactive (no press
                                  handler) — shows the intended IA shape
                                  without shipping fake controls
```

Guided-mode-first: no Adaptive/Expert controls are shown; nothing in the
domain model prevents adding them later.

## Native Android verification (mandatory, not unit-tests-only)

Performed on a real Android emulator, real SQLCipher-encrypted local
database, real local Postgres, real local API, and the same real local
JWT/JWKS test-issuer pattern established in the WDI slice. A **release**
build was used (embedded JS, no Metro dependency at runtime) — required
for the offline steps below, same reasoning as
`docs/architecture/WORKOUT-DATA-INTEGRITY.md`.

Verified, in order:

1. Athlete opens Plan (network on) — Current Block ("Hypertrophy —
   Upper/Lower", Week 4 of 6, 4x/week), This Week's 4 workouts correctly
   interleaved with 3 synthesized rest days, "Upper Body A" correctly
   emphasized as Today, Weekly Focus chips all render from the real
   seeded fixture via the real API.
2. Opened Workout Preview for "Upper Body A" — all 3 exercises (Bench
   Press, Overhead Press, Lat Pulldown) with correct rep ranges and load
   (e.g. "8–12 reps · 60kg") render exactly as seeded.
3. Tapped Start Workout — real chain executed: `PlanApplicationService
   .startWorkout` -> WDI `startWorkoutSession` -> real encrypted SQLite
   write. Landed on the (temporary) Active Workout placeholder showing
   the real session id and start timestamp read back from WDI.
4. Disabled Wi-Fi and mobile data, force-stopped the app process,
   relaunched — Plan's network fetch correctly failed with an honest
   error ("Could not load your plan... Failed to connect to
   /10.0.2.2:4000"), **and the Resume banner still rendered correctly**,
   proving active-session detection is genuinely local-only and survives
   a real process restart while fully offline.
5. Tapped Resume — identical `WorkoutSession` id and start timestamp as
   step 3, read from local encrypted storage with zero network.
6. Re-enabled network, returned to Plan, opened "Upper Body A" preview
   again, tapped Start Workout a **second** time on the same planned
   workout — landed on Active Workout showing the exact same session id
   as steps 3 and 5. WDI's own single-active-session guard prevented a
   duplicate; no Plan-layer code re-implements that check.

### Real bug found and fixed during this verification

`createPlanAuthTokenProvider()` originally gated its dev-JWT override on
`__DEV__ && EXPO_PUBLIC_DEV_JWT`. A release build (required for the
offline steps above) always has `__DEV__ === false`, so the override
could never activate in the one build variant that needed it — the app
fell back to `DeferredSupabaseAuthTokenProvider` and every screen showed
the honest "Supabase sign-in not implemented" error instead of loading
real data. Fixed by dropping the `__DEV__` condition; the env var's
absence in any real build pipeline is the actual safety boundary (see
"Auth wiring" above). A second, unrelated finding: Gradle's
`createBundleReleaseJsAndAssets` task caches by file input, not by
environment variables, so changing `EXPO_PUBLIC_*` values without
`./gradlew :app:cleanCreateBundleReleaseJsAndAssets` first silently
reuses a stale bundle — noted here for the next native verification
session.

### Plan Contract Integrity Fix Pass — re-verification

Repeated the same real-emulator/real-SQLCipher/real-Postgres/real-API
methodology above, seeded with a genuine rep **range** ("Bench Press",
8–12 reps, 40kg `PER_IMPLEMENT`) specifically to prove the `RepTargetV1`
fix, not just re-run the happy path:

1. Plan -> Preview -> Start Workout with network on, same real chain as
   before.
2. Disabled Wi-Fi and mobile data, force-stopped the app process,
   relaunched, tapped Resume — fully offline, same as the original
   verification.
3. A temporary diagnostic block (removed immediately after capturing
   evidence, not part of the shipped placeholder screen) rendered
   `session.prescription.exercises[].sets[].targetReps` as raw JSON.
   Confirmed on-device: `{"kind":"RANGE","minReps":8,"maxReps":12}` —
   the full range, not the pre-fix collapsed `8`, survives a real offline
   force-stop/relaunch reading only from local encrypted SQLite, with no
   network involved in restoring it.

This is the concrete evidence behind the "verified natively" claim in the
transformation section above; it is not inferred from the unit/integration
suite alone.

## Security review

- Ownership always derives from `AuthenticatedActor.athleteProfileId`,
  never a request parameter — confirmed by code inspection and the BOLA
  test (`PLAN-API-002`).
- JWT verification unchanged from the Auth/Identity foundation.
- No secrets in `apps/mobile`: the dev-JWT override requires an explicit,
  gitignored `.env.local` value; no production build pipeline sets it.
- Plan Start cannot create a session owned by another athlete: the
  prescription embedded in `WorkoutPreviewV1` is only ever reachable
  after the same ownership-checked query that serves the preview itself.

## Explicitly deferred (tracked, not forgotten)

- ~~Full Today screen~~ — implemented (Athlete Mobile Today V1
  Foundation, see `CLAUDE.md`): `/` is now Today
  (`apps/mobile/app/index.tsx`), reusing this same
  `PlanApplicationService` boundary and `PlanOverviewV1` contract
  unchanged; Plan moved to `/plan` (`apps/mobile/app/plan.tsx`), behavior
  unchanged. Progression Review on Today remains deferred to Progression
  Application Slice E.
- Plan offline cache/sync protocol.
- ~~Multi-block "current block" edge cases beyond the fallback heuristic~~
  — replaced by Schedule Calendar Authority V1
  (`docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md`): athlete-local date,
  strict date-containing current cycle, explicit BEFORE_PLAN/GAP/AFTER_PLAN
  with a labelled presentation cycle, deterministic active program.
- Planned RIR target, `PlannedExercise.role`, Exercise Taxonomy.
- ProgramVersion editing UX (data model + activation semantics only).
- The polished Active Workout logger (separate slice).
