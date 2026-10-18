# Vostivo — Available-Time Adaptation V1 Specification

**Status:** Available-Time Adaptation V1 is **CLOSED** (2026-10-05): Slice A
(pure engine, §1–16), Slice B (server preview, §17), Slice C (durable
TODAY_ONLY application and adjusted offline-first START, §18) and Slice D
(athlete UI, §19, human acceptance PASS) are all closed. The original Slice A
text below is kept as written.

**Scope:** the first Training Intelligence vertical. Implements only the
mechanics of "the athlete has less time than the planned session
requires" — nothing else.

---

## 1. Purpose

Vostivo's adaptation principle is **PRESERVE THE PLAN**: when real life
constrains a session, make **the smallest necessary change without
losing long-term direction**. Available-Time Adaptation V1 answers one
question — given a planned session and how much time the athlete
actually has, what is the smallest set of already-planned reductions
(never additions, substitutions, or reordering) that fits the budget
while protecting the most important work?

This document is the **canonical approved methodology** — tech-lead
resolution pass, superseding the prior "BLOCKED — METHODOLOGY GAP" report
(the repository genuinely had no priority/duration model before this).

## 2. Scope / non-goals

**In scope (V1):** a pure, deterministic function that reduces an
already-planned session's `WORKING` sets (never `WARM_UP`, never adding/
swapping/reordering exercises) to fit an available-time budget, using an
explicit priority-tier and minimum-working-sets model supplied by the
caller.

**Explicitly out of scope (Slice A):**

```text
Persistence (no new table/migration)     Job/worker orchestration
API endpoints                            Mobile UI ("35 min version" card)
Mode/authority (GUIDED/ADAPTIVE/EXPERT)  Progression Engine coupling
Pain/discomfort adaptation                Equipment substitution
Missed workout / return-after-break       Schedule shift
Fatigue/deload/plateau handling           Athlete Memory
Sport interference                        Warm-up trimming/optimization
Real learned duration estimates           Priority/minimum persistence
```

Priority (`priorityTier`) and minimum-working-sets (`minimumWorkingSets`)
values are consumed by the pure engine as **already-resolved normalized
input** — where they are authored/persisted in `PlannedExercise` (or
elsewhere) is an explicit Slice-B architecture decision, not this
document's concern.

## 3. Priority model — locked

Every normalized planned exercise carries a `priorityTier`:

| Tier | Meaning |
|---|---|
| `TIER_1` | Highest adaptation priority — most protected |
| `TIER_2` | Supporting important work |
| `TIER_3` | First reducible work |

This is **not** compound/accessory, exercise taxonomy, or a muscle
category, and it is never inferred from `exerciseKey`/exercise name/order
— it is an explicit, opaque input value.

## 4. Minimum working sets — locked

Every normalized planned exercise also carries `minimumWorkingSets:
integer >= 0`, with the invariant `minimumWorkingSets <= (count of that
exercise's WORKING sets)`. The engine may never retain fewer `WORKING`
sets for an exercise than this value. `minimumWorkingSets = 0` means the
whole exercise may eventually be fully removed.

**At least one exercise in a valid normalized session must have
`minimumWorkingSets > 0`** — otherwise the input is rejected
(`NO_EXERCISE_WITH_POSITIVE_MINIMUM`). This is what prevents an "empty
workout" from ever becoming the minimum meaningful session.

## 5. Reduction order — locked

Deterministic removal order:

1. All of `TIER_3`'s reducible work, before touching `TIER_2`.
2. All of `TIER_2`'s reducible work, before touching `TIER_1`.
3. `TIER_1` last.

**Within the same tier:** the exercise with the LATER authored
`orderIndex` is reduced before an earlier one.

**Within one exercise:** only the LAST retained `WORKING` set may ever be
removed next — a strict suffix reduction. Working set 2 is never removed
while working set 3 is still retained. Exercise/set ordering is otherwise
never changed.

## 6. Smallest-necessary-change algorithm — locked

1. Estimate the full authored session's duration (§8).
2. If it already fits the available time: **`NO_CHANGE`**.
3. Otherwise, select the single next removable `WORKING` set per §5's
   order, remove exactly that one set, and re-estimate.
4. Repeat step 3, stopping the instant
   `estimatedDurationSeconds <= availableTimeSeconds`.
5. If no further reduction is possible (every exercise is either fully
   removed or already at its own `minimumWorkingSets`) and the budget
   still isn't met, the session is at its structural minimum (§7) and
   still doesn't fit: **`CANNOT_FIT_MINIMUM`**.

This performs the minimum number of sequential, policy-ordered
reductions necessary — never a global subset optimization, knapsack, ML
ranking, or random search. V1 explainability is prioritized over
theoretical combinatorial optimality.

## 7. Whole-exercise removal and warm-up policy — locked

When an exercise's `minimumWorkingSets = 0` and its last retained
`WORKING` set is removed, the **whole exercise is removed**, and every
one of its `WARM_UP` sets is removed with it — no warm-up-only exercise
may ever remain.

If an exercise retains at least one `WORKING` set, **all of its authored
`WARM_UP` sets remain completely unchanged** — V1 never trims warm-up
count, recalculates warm-up loading, changes warm-up reps, or optimizes
warm-up duration. Future warm-up intelligence is explicitly deferred.

## 8. Time Estimation Policy V1 — locked

Policy identifier: **`available-time/v1`** (`{engine: "available-time",
policy: "v1"}`, `packages/training-engine/src/available-time/policy.ts`).

Constants (`packages/training-engine/src/available-time/duration.ts`,
the one named source — never scattered elsewhere):

```
SET_EXECUTION_SECONDS = 30
EXERCISE_SETUP_TRANSITION_SECONDS = 60
```

These are explicit V1 **estimation** constants, not claims about exact
real-world duration — a future policy version may introduce real learned
estimates without changing this one's own numbers retroactively (the
Progression Engine's own versioning discipline: same input + same
version = same output, forever).

For every RETAINED exercise: `60s setup/transition` + `30s` for every
retained set (`WARM_UP` or `WORKING`, no distinction) + the authored
`restSeconds` **between** retained sets. No rest is counted after the
last retained set. A fully removed exercise costs nothing — not even the
60s setup.

Worked example (3 retained sets, rest after set 1 = 120s, rest after set
2 = 120s): `60 + 30 + 120 + 30 + 120 + 30 = 390` seconds.

## 9. Rest data requirement — locked

The engine never guesses missing rest (no `null -> 90s` default, no
role-based default). `restSeconds` is a **required**, non-negative
integer field on every input `WORKING`/`WARM_UP` set — the normalized
input type makes this a compile-time guarantee rather than a runtime
null-check; a malformed value (`INVALID_REST_SECONDS`) is a deterministic
validation failure, never silently coerced.

## 10. Minimum meaningful session — locked

There is **no arbitrary global minimum** (no "15 minutes," no "6 sets").
The minimum meaningful session is purely **structural**: every exercise
with `minimumWorkingSets > 0`, retained at exactly that many `WORKING`
sets, plus all of its authored `WARM_UP` sets; every exercise with
`minimumWorkingSets = 0` may be fully removed. Its estimated duration is
computed with the exact same §8 policy. If that duration still exceeds
the available time, the result is `CANNOT_FIT_MINIMUM` — exercise minima
are never violated to force a fit.

## 11. Result vocabulary — locked

Exactly one of:

- **`NO_CHANGE`** (`FITS_WITHOUT_CHANGE`) — the full authored session
  already fits.
- **`ADJUST_SESSION`** (`REDUCED_TO_FIT_AVAILABLE_TIME`) — one or more
  policy-ordered reductions produced a session within budget.
- **`CANNOT_FIT_MINIMUM`** (`MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME`) —
  even the structural minimum doesn't fit.

No nullable/ambiguous result. Structurally invalid input is a distinct,
separate outcome (`Result.err`, never silently mapped to any of the
three decisions above).

## 12. Normalized input

```ts
interface AvailableTimeSetV1 {
  readonly setKey: string;
  readonly orderIndex: number;
  readonly setType: "WORKING" | "WARM_UP"; // @vostivo/domain SetType
  readonly restSeconds: number; // required, non-negative — never guessed
}

interface AvailableTimeExerciseV1 {
  readonly exerciseKey: string;
  readonly orderIndex: number;
  readonly priorityTier: "TIER_1" | "TIER_2" | "TIER_3";
  readonly minimumWorkingSets: number; // 0 <= x <= WORKING set count
  readonly sets: readonly AvailableTimeSetV1[];
}

interface AvailableTimeInputV1 {
  readonly availableTimeSeconds: number;
  readonly exercises: readonly AvailableTimeExerciseV1[];
}
```

No `userId`, mode, subscription, `GymProfile`, `LoadingCapability`, or
progression state — mode/authority is an outer, application-layer
concern for a future slice, never a branch inside this mechanical engine.
`exerciseKey`/`setKey` are opaque, stable input references; the future
assembler owns what they actually mean (e.g. a real `PlannedExercise.id`/
`PlannedSet.id`).

## 13. Output evidence

`ADJUST_SESSION` carries: `policyVersion` (`kind`+`version` on the
enclosing `EngineDecision`), `availableTimeSeconds`,
`originalEstimatedDurationSeconds`, `adjustedEstimatedDurationSeconds`,
`retainedExercises` (exact retained set keys per exercise, in original
order), `removedWorkingSets` (the exact reduction sequence, in removal
order — this doubles as the "why," since the order is the policy itself),
and `fullyRemovedExercises`.

`CANNOT_FIT_MINIMUM` carries: `availableTimeSeconds`,
`originalEstimatedDurationSeconds`, `minimumEstimatedDurationSeconds`,
and `minimumRetainedExercises` (the exact structural-minimum retained
set keys per exercise).

`NO_CHANGE` carries: `availableTimeSeconds`, `estimatedDurationSeconds`
only — no reduction evidence, since none exists.

No free-text/athlete-facing prose is generated inside the engine — every
`reasonCode` is a closed-vocabulary value; a future application/UI layer
maps it to copy.

## 14. Validation — fail closed

Structurally invalid input (never auto-repaired) includes: negative
`availableTimeSeconds`; no exercises; duplicate exercise key/orderIndex;
negative or excessive `minimumWorkingSets`; no exercise with a positive
minimum; an exercise with zero sets; duplicate set key/orderIndex within
an exercise; an unsupported `setType`/`priorityTier`; invalid/negative
`restSeconds`. See `packages/training-engine/src/available-time/
validate-input.ts` for the exhaustive, closed error vocabulary.

## 15. Determinism

No `Date.now()`, randomness, database read, device state, or
locale-dependent logic anywhere in the engine. Tie-breaking comes only
from `priorityTier`, exercise `orderIndex`, and working-set `orderIndex`
— all explicit input. The input object is never mutated (the reduction
loop operates on freshly built internal working state, never on the
caller's own arrays/objects).

## 16. Implementation evidence — Slice A (2026-09-24)

`packages/training-engine/src/available-time/`: `vocabulary.ts`
(`PriorityTierV1`, result-kind/reason-code closed vocabularies),
`input.ts` (`AvailableTimeInputV1`), `duration.ts` (the one named
`SET_EXECUTION_SECONDS`/`EXERCISE_SETUP_TRANSITION_SECONDS` source),
`validate-input.ts` (`Result`-based structural validation, same
convention as the Progression Engine's `validateProgressionInput`),
`decision-data.ts` (`AvailableTimeDecisionDataV1`), `policy.ts`
(`availableTimePolicyV1` + the recommended `evaluateAvailableTime()`
entry point, mirroring `evaluateProgression()` exactly).

**Tests** (100 total in `@vostivo/training-engine`, up from 64 before
this slice): `duration.test.ts` (6, including the exact locked worked
example — 390s), `validate-input.test.ts` (15, one per closed error
reason), `policy.test.ts` (15) covering every required example class
(§18 A–M): full-fits `NO_CHANGE`; a small deficit removing exactly one
set; `TIER_3` fully exhausted (later-exercise-first) before `TIER_2` is
ever touched; the full `TIER_3 -> TIER_2 -> TIER_1` cascade; suffix
(last-set-first) reduction within one exercise; whole-exercise removal
including its warm-up; a retained exercise's warm-ups always intact; the
structural minimum both just-under (`CANNOT_FIT_MINIMUM`) and exactly-at
(`ADJUST_SESSION`, never reduced further) the available-time boundary;
repeated-call determinism; input-object immutability; and an explicit
monotonicity invariant across 10 budgets from 100s to 1000s (more
available time never retains less working work).

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; existing Progression Engine pure tests (61)
re-run unaffected.

**Explicitly deferred** (Slice B and beyond, pending tech-lead approval):
priority/minimum persistence in the Plan schema; program-builder UI;
Available-Time input UI (Today); `EngineDecision` persistence; job/API/
mobile orchestration; mode authority (GUIDED auto-apply vs.
ADAPTIVE/EXPERT review); warm-up trimming intelligence; real learned
duration estimates.

## 17. Slice B — server preview orchestration (2026-10-05)

```text
REAL PLAN -> SERVER NORMALIZATION -> PURE ENGINE (available-time/v1) -> READ-ONLY PREVIEW
```

Status: CLOSED (2026-10-05).

**Authored field ownership.** `priorityTier` (`TIER_1`/`TIER_2`/
`TIER_3`) and `minimumWorkingSets` (integer `>= 0`) are authored
PROGRAM STRUCTURE on `app.planned_exercises` (migration `0015`, enum
`app.planned_exercise_priority_tier`, CHECK `minimum_working_sets IS
NULL OR >= 0`). They are not Athlete Memory, not workout-history
observations, and never inferred from name, order, taxonomy, muscle group
or set count. Both columns are **nullable with no default**: NULL is a
*database compatibility* state ("authored before this policy existed"),
not a product value. A workout with any NULL is simply not eligible, and
its preview fails closed. Every authoring path writes both values
explicitly; the dev `SMALL_FIXTURE` authors Bench Press `TIER_1`/min `2`
and Overhead Press `TIER_2`/min `0` (tech-lead decision). Other seeded
workouts stay NULL on purpose.

**Endpoint.** `POST /api/v1/plan/workouts/:plannedWorkoutId/available-time-preview`
with body `{ "availableMinutes": <integer 1..240> }`. This nests under the
existing `GET /plan/workouts/:plannedWorkoutId` Workout Preview. It is a POST
only because it carries a body: it is read-only and answers `200`.
Floats, numeric strings, a missing value or any extra field (for example a
client `athleteId`) are rejected with `400` by the global `ValidationPipe`. A
malformed id is also a `400`. Contract: `AvailableTimePreviewResponseV1`
(`packages/contracts`).

**Orchestration** (`apps/api/src/plan/available-time-preview.service.ts`
+ pure `available-time-preview.ts`):

1. ownership via the same `planned_workouts -> ... -> programs.athlete_profile_id`
   join as the Workout Preview. Not found and not owned are the same `404`
   (no existence leakage); identity comes only from `AuthenticatedActor`.
2. the workout-state guard (below).
3. load the canonical exercises and sets, then normalize to `AvailableTimeInputV1`.
4. `evaluateAvailableTime()`, the only implementation of the policy.
5. reshape the decision into the contract.

The service only SELECTs. It creates no EngineDecision,
adaptation/application row, ProgramVersion, WorkoutSession, prescription
snapshot, Today-only override or Athlete Memory item. **A preview is not
an application.** A later TODAY_ONLY adaptation still does not create a
ProgramVersion.

**Effective-prescription boundary.** The preview reads the same
`planned_exercises`/`planned_sets` rows that
`createWorkoutPrescriptionFromPlannedWorkout` turns into the prescription a
workout START uses. The progression effective-load overlay changes a
set's *load*, never *which sets exist*, so it is deliberately not
consulted. Available-Time owns structural inclusion only (no load, reps,
RIR, substitution, capability or goal changes).

**Normalization rules.** Exercises and sets are ordered by authored
`orderIndex`; `setType` carries the WORKING/WARM_UP distinction. A NULL
`priorityTier` → `AVAILABLE_TIME_PRIORITY_TIER_MISSING`, a NULL
`minimumWorkingSets` → `AVAILABLE_TIME_MINIMUM_WORKING_SETS_MISSING`, and a
NULL `restSeconds` on any set that is *not* its exercise's last authored
set → `AVAILABLE_TIME_REST_SECONDS_MISSING`. The engine's own validation
(minimum > working count, no exercise with a positive minimum, no
exercises/sets, ...) → `AVAILABLE_TIME_STRUCTURE_INVALID`. All of these
return `422`, with only the stable code exposed.

One deliberate normalization: per §8 the rest after the final retained set
is never counted, and an exercise's last *authored* set is always the last
of whatever is retained. So a NULL there is never read by the policy. It is
normalized to `0` (provably unused, not a guessed default) instead of
blocking. This is the only NULL rest that is ever accepted.

**Result mapping.** `NO_CHANGE` gives `adjusted == original` with nothing
removed. `ADJUST_SESSION` mirrors the engine result exactly.
`CANNOT_FIT_MINIMUM` returns the structural-minimum session, with
`adjustedEstimatedSeconds == minimumEstimatedSeconds` (the engine's own
field) and `fitsAvailableTime: false`. It never reports a duration below
that minimum. `minimumEstimatedSeconds` is null for the other results.

**`previewFingerprint`.** SHA-256 of `canonicalStringify` (the existing
progression-fingerprint helper) over: fingerprint schema id, policy
version, `plannedWorkoutId`, source `programVersionId`, every exercise's
id/order/tier/minimum, every set's id/order/type/**authored** rest (NULL
stays NULL), and `availableMinutes`. There are no timestamps and no
randomness, and row order does not matter. It is a **stale-input guard for
Slice C, not an authentication or authorization token**.

**Workout-state guard.** Preview is PRE-START only. If an ACTIVE or
COMPLETED session exists for this planned-workout occurrence (matched by
`prescriptionSnapshot.prescriptionId`, through the one shared
`findMatchingSessions` that the Plan/Workout Preview projections also use),
the answer is `409 WORKOUT_ALREADY_STARTED`. **Resume / an in-progress
workout always takes precedence over time adjustment.**

**Tests.**
- `available-time-preview.test.ts` (23, pure): vocabulary locks (DB tier
  enum equals `PRIORITY_TIERS_V1`, policyVersion equals the engine version),
  normalization, every fail-closed case, and the fingerprint's determinism
  and sensitivity.
- `plan.controller.test.ts` (+13): auth, request validation, malformed id,
  and the 409/422 mapping.
- `available-time-preview.integration.test.ts` (20, real Postgres):
  round-trip, DB CHECK, owner, BOLA, ACTIVE/COMPLETED guard, NO_CHANGE /
  ADJUST / CANNOT_FIT on the fixture, TIER_2-before-TIER_1, whole-exercise
  removal, the TIER_1 minimum floor, exact durations for every budget from
  1 to 10 min, zero mutations, and fingerprint stability and change.

**Not in Slice B:** mobile UI, Today chips, starting an adjusted workout, an
adjusted prescription snapshot, a persisted decision/application,
auto-apply, coach flow, history and mode authority.

## 18. Slice C — durable TODAY_ONLY application + adjusted offline-first START (2026-10-05)

```text
REAL PLAN -> SERVER PREVIEW -> EXPLICIT ATHLETE CHOICE -> LOCAL ATOMIC START
          -> IMMUTABLE ADJUSTED PRESCRIPTION -> ASYNC SYNC
          -> SERVER VERIFY / STALE CLASSIFICATION
```

Status: CLOSED (2026-10-05), including the closure patch.

**Invariants (locked):**

1. **TODAY_ONLY NEVER CREATES A PROGRAMVERSION.** An adjusted START writes
   a session, its snapshot and one application row, and nothing in the plan.
2. **LOCAL WORKOUT REALITY IS NOT DISCARDED SOLELY BECAUSE A PREVIEW BECOMES
   STALE.**
3. **SERVER VERIFICATION STATUS DOES NOT MUTATE THE HISTORICAL
   PRESCRIPTION.**
4. **AVAILABLE-TIME CHANGES STRUCTURE, NOT PROGRESSION/LOAD OWNERSHIP.**
5. **THE USER MUST EXPLICITLY CHOOSE "START ADJUSTED WORKOUT" IN ALL ATHLETE
   MODES.** GUIDED, ADAPTIVE and EXPERT all follow the same backend
   semantics. There is no auto-apply.

**Exact structural diff (preview extension).** Every preview exercise now
also carries `retainedPlannedSetIds` and `removedPlannedSetIds`:
- canonical authored order;
- they cover all authored sets, warm-ups included, and partition them;
- they are derived from the same retained set as the counts, so the two
  cannot disagree.

The response also carries `sourceProgramVersionId`. Arrays and counts can't
disagree by construction. The client never re-derives the decision from
counts, and never re-implements `available-time/v1`.

**Eligibility.** Only `ADJUST_SESSION` is applicable:
- `NO_CHANGE` uses the ordinary START and creates no application.
- `CANNOT_FIT_MINIMUM` is refused at the application boundary, both
  mobile-side (`NOT_APPLICABLE`) and on the wire, where an application that
  doesn't fit its budget or removes nothing is malformed.
- There is no "start anyway" and no "minimum version" (a future product
  decision).

**`AvailableTimeApplicationV1`** (`packages/domain`):

```text
{ schemaVersion: 1, scope: "TODAY_ONLY", policyVersion: "available-time/v1",
  plannedWorkoutId, sourceProgramVersionId, availableMinutes,
  previewFingerprint, originalEstimatedSeconds, adjustedEstimatedSeconds,
  exercises: [{ plannedExerciseId, retainedPlannedSetIds, removedPlannedSetIds }] }
```

It's built only by the shared `availableTimeApplicationFromPreview`
(`packages/contracts`), a pure reshaping of the server's ids. It's
immutable once started. It is stored once locally
(`local_workout_sessions.available_time_application_json`, local migration
`0012`) and carried in the session's START payload. The fingerprint is a
stale-input guard, never authorization.

**Adjusted prescription.** `selectAvailableTimePrescription` (domain) is
the one structural filter. It starts from the **same effective
prescription a normal START uses**: the server Workout Preview's
`prescription`, which already includes the progression effective-load
overlay. It keeps exactly the retained sets as the *same objects*, in
canonical order: removed sets disappear, an exercise with no retained set
disappears, and warm-ups are kept exactly as the preview says. Load, reps,
rest and set type are never recomputed. The order is canonical prescription →
existing effective resolution → Available-Time structural filter →
immutable snapshot. Normal and adjusted sessions share the one
`WorkoutPrescriptionV1` model.

**Mobile operation.** `AdjustedWorkoutStartService.startAdjustedWorkout`
(`apps/mobile/src/workout/adjusted-workout-start.ts`, no UI yet):
1. map the preview to an application (fails closed on an inconsistent preview);
2. filter the prescription (fails closed unless the ids exactly partition
   this prescription);
3. `WorkoutRepository.startWorkoutSession(adjusted, application)`: session,
   snapshot, application and START outbox command in ONE SQLite transaction;
4. only after commit, `WorkoutSyncCoordinator.requestSync("mutation")`, fire
   and forget.

There's no online request before START. An existing active session wins
(`ALREADY_ACTIVE`, Resume).

**Server persistence.** `app.available_time_applications` (migration
`0016`) has at most one row per session (unique `workout_session_id` FK),
plus `user_id` FK. `planned_workout_id` and `source_program_version_id` are
plain historical references, not FKs, by the same rule as the session
snapshot. Other columns: scope enum, `policy_version` CHECK, minutes CHECK
1..240, fingerprint, both estimates, the `structural_diff` JSONB (the exact
applied per-exercise diff), and `verification_status`
(`VERIFIED`/`STALE`/`UNVERIFIED`) plus `verification_reason`. It is written in the
same transaction as the session and its receipt; replays are idempotent
through the existing receipt machinery and the unique index. It is **not**
`progression_applications` and not an EngineDecision.

**Verification** (closure patch, `apps/api/src/workout/available-time-start.ts`,
pure `decideAvailableTimeStart`). The decision is made in full BEFORE
anything is written. It runs over the provenance that the shared START check
(below) has already established.

| Outcome | Meaning |
|---|---|
| **VERIFIED** | Exactly re-derived, and current. The server independently re-ran the Slice B normalization and `available-time/v1` over the owned source, and the fingerprint, result kind, both durations and the exact retained/removed ids all match. The source ProgramVersion and Program are ACTIVE. |
| **STALE** (`SOURCE_NOT_CURRENT`) | Exactly re-derived, but no longer current. Everything above matches, but the source ProgramVersion/Program is no longer ACTIVE (for example, a preview from A, then B became current before sync). Accepted: the historical session and its snapshot are preserved, and later set/finish commands apply. |
| **UNVERIFIED** (`SOURCE_NOT_EVALUABLE`) | A legitimate, owned historical source that cannot be fully re-evaluated. Ownership and integrity hold (no foreign ids, the snapshot is exactly the retained structure), but `available-time/v1` cannot run over the owned source any more, so no contradiction can be proven. Accepted. Under immutable ProgramVersions this cannot occur naturally in V1. The state is kept for future-safe history, and is exercised only through the pure decision function, never through a permissive production path. |
| **REJECTED** | The server can evaluate the source and proves that the client payload contradicts the canonical deterministic result (`FINGERPRINT_MISMATCH`, `RESULT_MISMATCH`, `DURATION_MISMATCH`, `DIFF_MISMATCH`), or ownership/integrity fails (`SOURCE_NOT_PLANNED`, `SOURCE_VERSION_MISMATCH`, `FOREIGN_EXERCISE`, `FOREIGN_SET`, `SNAPSHOT_MISMATCH`, a malformed application or partition, an unknown policy/version). The existing protocol's `REJECTED` outcome and receipt apply: no WorkoutSession and no application row (the adjusted START never became server reality), and never a 500. |

**UNVERIFIED IS NOT A FALLBACK FOR TAMPERED OR MISMATCHING CLIENT DATA.**

An unexpected server failure inside the START transaction (proven with a
test-only failure trigger on the application insert) rolls back the session,
the application, the receipt and the cursor entry together. It surfaces as
an error (a 5xx on the wire, retryable per the existing protocol), and the
retried command then applies exactly once.

**Ordinary START provenance hardening** (closure patch,
`apps/api/src/plan/planned-provenance.ts`, `resolveStartProvenance`). This
closes a pre-existing gap: until now, START stored any snapshot unchecked,
while progression resolves `prescriptionExerciseId` against
`planned_exercises` without an owner filter. EVERY START (ordinary and
adjusted) is now checked before any write, through the one shared ownership
primitive (`findOwnedPlannedWorkoutSource`):

- a snapshot whose `prescriptionId` is a planned workout must be the
  athlete's own. Every exercise and set identity in it must be that
  workout's own planned exercise/set, each set under its own exercise.
  Ownership, not freshness: an owned workout from a SUPERSEDED version still
  starts.
- a snapshot whose `prescriptionId` is not a planned workout is unplanned,
  which remains supported, including client-generated UUIDs. It may carry
  no planned exercise/set identity at all, so it is never silently turned
  into a planned workout.

Any violation returns the same reason-less `REJECTED`: the acknowledgement
never says whose plan an id belongs to. The wire `WorkoutPrescriptionV1`
carries no ProgramVersion id. An ordinary START's version is implied by its
owned workout, and the adjusted START's explicit `sourceProgramVersionId` is
checked as above.

Residual: an attacker who already holds another athlete's planned-workout
UUID can tell "exists, foreign" (REJECTED) from "does not exist" (accepted
as unplanned). That is one bit, and no data is exposed. UUIDv7 ids are not
guessable.

**One planned occurrence, several sessions (multi-device). RESOLVED** by
Planned Workout Occurrence Authority V1 (`docs/architecture/
WORKOUT-DATA-INTEGRITY.md`). Normal and adjusted STARTs compete for one
occurrence claim. The first server-accepted START is CANONICAL; a later
distinct one is SECONDARY, still accepted, and keeps its own application
row. Being SECONDARY is unrelated to the application's
VERIFIED/STALE/UNVERIFIED status. Only the canonical session represents the
occurrence for Plan/Today, the preview guard and planned progression.

**Tests.**
- **Domain (38):** validator reasons, the filter (partition, order,
  warm-up, effective load, no mutation), snapshot integrity and hostile
  shapes.
- **Contracts (+4):** preview → application, including NO_CHANGE and
  CANNOT_FIT refused.
- **API unit:** preview id arrays (+6) and the START mapping (6).
- **Real Postgres:** preview id arrays (+2) and adjusted START (initially 10; the closure patch adds 9 — result/duration/fingerprint/diff rejection, injected-failure rollback + clean retry, ordinary START provenance): VERIFIED
  happy path, effective load, idempotent replay, BOLA, forged
  set/exercise/version/snapshot, the client diff not trusted, the A→B STALE
  scenario with later COMPLETE_SET, UNVERIFIED preserved, zero plan mutation
  or decision artifacts, and ordinary START unchanged.
- **Mobile (15):** run on a **real SQLite engine** (`node:sqlite` behind
  drizzle's expo driver, the real repository SQL and real migrations):
  exact structure, atomicity, an injected in-transaction failure leaving
  nothing behind, sync only after commit, process death recovering the
  same session with no second one, NO_CHANGE/CANNOT_FIT refused, and an
  ordinary START unchanged.

**Not in Slice C:** Today chip/UI, preview sheet, production
start-adjusted button, CANNOT_FIT UX, coach flow, history, Athlete Memory,
auto-apply, generic adaptation framework.

## 19. Slice D — athlete UI + preview + local-first adjusted START (2026-10-05)

```text
Today -> Adjust time -> choose minutes -> server preview -> explicit athlete choice
      -> local-first adjusted START -> Active Workout
```

Status: **CLOSED / PASS** (human acceptance, 2026-10-05; see below). It is built on the
approved Claude Design flow (Premium Performance / Refined Dark) and reuses
the existing Today and Active Workout. The Claude Design MCP was not
reachable from the implementation session, so the specification plus the
existing tokens and components were the reference.

**Locked V1 UX:**
- **Entry.** A quiet, underlined **Adjust time** beside the hero's duration
  (full 44pt touch target, label "Adjust workout time"). It is secondary to
  the unchanged **Start Workout**. It is shown only for an eligible,
  unstarted TODAY planned workout. **Resume always wins.**
- **No default time.** 30 / 45 / 60 / 75 / Custom all start unselected, and
  **Preview changes** stays disabled until a valid time exists. Custom
  takes whole minutes 1–240 (numeric keypad), with restrained inline
  validation. Input is never clamped or rounded.
- **The preview shows changes only.** Unchanged exercises are hidden in V1,
  with no toggle. Rows read `N → M sets` or `Removed today`, built purely
  from the server response. There is no tier, minimum, id, fingerprint or
  policy text, and the client never re-derives the diff.
- **Estimates** use one rounding rule, `Math.ceil(seconds / 60)`, so the UI
  never understates a duration. The title uses the athlete's chosen budget
  (`35-min version`); the comparison uses the engine estimate.
- **ADJUST_SESSION** offers **Start adjusted workout** and **Keep
  original**. **NO_CHANGE** offers **Start workout**, which is the ORDINARY
  START (no application), and **Choose another time**.
- **CANNOT_FIT_MINIMUM** shows "Not enough time for the core work" and the
  shortest safe version. It offers only **Choose more time** and **Keep
  original**. It **cannot be applied**: there is no start, no "anyway" and
  no red styling.
- **A preview failure never blocks the original workout.** The screen
  reads "Couldn't adjust right now" with **Retry** (same minutes) and
  **Keep original**. No HTTP or technical text is shown.
- **Already started (409).** Today is treated as stale: the sheet
  dismisses and Today re-reads its normal path. Nothing is created.
- **All athlete modes require the explicit "Start adjusted workout".**
  There is no Guided auto-apply, and the flow has no mode input.
- **Active Workout** for an adjusted session shows only the restrained
  sublabel **Adjusted · {minutes} min**, from durable LOCAL metadata. An
  ordinary session renders exactly as before, with no node and no gap.
- Keep original, close, the backdrop and Android back never mutate
  anything.

**Implementation.**
- `apps/mobile/src/available-time/available-time-flow.ts` holds the pure
  state and presentation rules.
- `available-time-controller.ts` is the framework-free controller. The
  preview is single-flight, and late results after close or unmount are
  ignored.
- `available-time-sheet.tsx` is one sheet on React Native's built-in
  `Modal`, with keyboard avoidance and a safe-area footer so the actions
  stay reachable.
- The Today and Active Workout changes are minimal.

The canonical Workout Preview is fetched **together with** the time
preview, so both starts are purely local. The adjusted start goes through
Slice C's `AdjustedWorkoutStartService` with the exact server objects:
local atomic START, then immediate navigation, then fire-and-forget sync,
with no network call before the start. That boundary is proven over the
real SQLite repository: the preview succeeds online, every later API call
fails, and the adjusted START still commits and navigates. No native or JS
dependency was added.

**Human acceptance — PASS (2026-10-05, emulator `Vostivo_Light`, `vostivo_manual`, SMALL_FIXTURE, ADAPTIVE).**

| Checkpoint | Result |
|---|---|
| Today | "60 min · Adjust time" (quiet) beside a dominant **Start Workout**; no Resume |
| Sheet opens | no time preselected; **Preview changes** disabled |
| Custom 9 | **NO_CHANGE**, "Your workout already fits", ~9 min |
| Custom 3 | **CANNOT_FIT_MINIMUM**, shortest safe version ~4 min (210 s); no start action |
| API stopped, Custom 8 | **PREVIEW_ERROR** with Retry / Keep original, no technical text |
| API restored, Retry | reused the **same 8 minutes**, giving **8-min version**: Original ~9 min, Adjusted ~7 min, **Overhead Press 2 → 1 sets** only (Bench unchanged, so hidden) |
| API stopped again, **Start adjusted workout** | **local-first** start with no server: Active Workout opened at once, **Adjusted · 8 min**, Bench 3 sets, OHP exactly 1 set (removed set absent), ACTIVE |
| API restored, app untouched | **passive** catch-up: API reachable 22:56:39.443, START persisted 22:57:04.294 (~25.9 s), trigger `retry`, same app process, no foreground/background or mutation |
| Server | 1 ACTIVE session (client-generated; `started_at` = offline local start), 1 APPLIED START receipt, 1 **VERIFIED** `TODAY_ONLY` application (8 min, 540 → 420 s; Bench 3/0, OHP 1/1), 1 **canonical** occurrence claim, 0 performed sets, 0 progression decisions/applications, no duplicates or rejects |

Two test-environment incidents happened during the session, and both were
diagnosed as **not source defects**:
- An accidental ordinary START from the human tester led to a clean manual-DB reset.
- An accidental sheet dismissal before Retry: the sheet's window drew no
  render between PREVIEW_ERROR and its removal, so Retry was never pressed.

**Known follow-up, not a Slice D blocker:** the emulator soft-keyboard /
IME behavior was unstable during testing (an IME-picker system ANR under
host IO load, since fixed). The Custom-minutes keyboard behavior should get
a later **physical-device smoke check**.

