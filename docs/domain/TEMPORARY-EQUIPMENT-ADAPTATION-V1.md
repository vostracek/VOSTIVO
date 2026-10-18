# Vostivo — Temporary Equipment / Gym Adaptation V1 Specification

**Status:**
- Slice A (pure deterministic substitution policy, `equipment-adaptation/v1`)
  — **CLOSED**.
- Exercise & Equipment Reference Catalog V1 — **CLOSED**.
- Curated Substitution Seed V1 — **CLOSED**.
- Slice B (read-only server preview) — **CLOSED** (2026-10-10). See §11.
- Slice C (durable TODAY_ONLY application + START, incl. the START
  integrity closure fix) — **CLOSED**. See §12.
- Slice D (athlete mobile UX) — **CLOSED / PASS** (human acceptance
  2026-10-17; implemented 2026-10-12). See §13.

**Temporary Equipment / Gym Adaptation V1 — FULLY CLOSED (2026-10-17).**

There is no authored plan mutation and no Gym Profile. The substitution vocabulary
(`SUBSTITUTE_COMPATIBILITY_TIERS_V1`, `PRESCRIPTION_COMPATIBILITIES_V1`,
`EquipmentIdV1`) is defined once in `@vostivo/domain` and re-exported
unchanged by the engine module.

## 1. Locked rules

```text
PRESERVE THE EXERCISE ROLE, CHANGE THE TOOL.
SMALLEST NECESSARY CHANGE.
TEMPORARY EQUIPMENT CHANGES ARE SESSION-ONLY.
CURATED SUBSTITUTES ONLY.
MACHINE OCCUPIED IS A REORDER PROBLEM FIRST, NOT AN AUTO-SWAP.
PRESERVE WORKING PRESCRIPTION WHEN EXPLICITLY COMPATIBLE.
NEVER COPY LOAD BETWEEN DIFFERENT EXERCISES.
ACTUAL EXERCISE HISTORY REMAINS SEPARATE.
NO WHOLE-WORKOUT REGENERATION.
NO SILENT PARTIAL APPLICATION.
```

Slice A handles one intent: equipment that is **unavailable for this
session**.

- It does not cover "the machine is occupied right now". That stays an
  Active Workout reorder / come-back-later interaction. A Swap is only
  possible if the athlete explicitly chooses it, using these same curated
  semantics.
- Out of scope: pain or injury, preferences beyond explicit blocks,
  fatigue, available time, scheduling, permanent gym setup, coach
  override, and generated exercises.

## 2. What exists in the domain model (inspected 2026-10-10)

| Concept | What exists |
|---|---|
| Exercise identity | `exerciseRef` (`ExerciseIdentityV1`, an opaque string on `PlannedExercise`/`PrescribedExerciseV1`/`PerformedExercise`). Performance history is keyed by it (Previous / progression). |
| Exercise Taxonomy, roles, muscles | None. `PlannedExercise.role` is explicitly not implemented. |
| Equipment | No catalog, no equipment requirements, no availability. LoadingCapability / `gym_profiles` model loading INCREMENTS only, not which equipment exists. |
| Substitution / Swap | None. The Active Workout Swap was deliberately omitted. |
| Set prescription | `setType` (WORKING / WARM_UP), `targetReps` (`RepTargetV1`), `restSeconds`, `targetLoad` (per set, including warm-ups). **No planned RIR exists** (deferred), so there is nothing RIR-related to preserve. |
| Available-Time | `priorityTier` / `minimumWorkingSets` per planned exercise. |

Identity and equipment are therefore cleanly separable. Slice A takes
equipment ids, curated candidates, locks and blocks as pure caller-supplied
input and persists nothing.

## 3. Input (`EquipmentAdaptationInputV1`)

- **`exercises[]`** — today's session, one entry per planned exercise:
  - `plannedExerciseId`, `exerciseId` (= `exerciseRef`), `order` (authored
    position, the only ordering authority);
  - `requiredEquipmentIds` — stable opaque ids, never names;
  - `substitutionPolicy` — `ALLOW_TEMPORARY` / `LOCKED`;
  - `sets` — `plannedSetId`, `order`, `setType`, `targetReps`,
    `restSeconds`, `targetLoad`;
  - `availableTime` — passthrough only;
  - `candidates[]` — curated substitutes, each with
    `substituteExerciseId`, `compatibilityTier`
    (`ROLE_EQUIVALENT` / `ROLE_COMPATIBLE`), `substitutionPriority`
    (positive integer, lower = better), `requiredEquipmentIds` and
    `prescriptionCompatibility`
    (`PRESERVE_WORKING_PRESCRIPTION` / `REQUIRES_PRESCRIPTION_CHANGE`).
- **`availableEquipmentIds`** — for THIS session only.
- **`athleteBlockedExerciseIds`** — explicit, caller-supplied preference.

There is no mode, clock, profile or gym in the input.

**Availability:** an exercise is performable if every required equipment id
is available. An exercise that needs no equipment is always performable.

## 4. Decision (`EquipmentAdaptationDecisionDataV1`)

### NO_CHANGE / `ALL_EQUIPMENT_AVAILABLE`

Every exercise is performable. No mapping is returned.

### ADJUST_SESSION / `TEMPORARY_EQUIPMENT_UNAVAILABLE`

Returned only when EVERY unavailable exercise resolved. It carries:

- **`replacements[]`** — only the affected exercises, in authored order.
  Each has:
  - `plannedExerciseId`, `authoredExerciseId`, `substituteExerciseId`;
  - `order` — the authored position, never reordered;
  - `reasonCode: TEMPORARY_EQUIPMENT_UNAVAILABLE`;
  - `prescription` with policy `PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD`:
    - `workingSetCount`;
    - the sets (`plannedSetId`, `order`, `setType`, `targetReps`,
      `restSeconds`) with **no load field**;
    - the `availableTime` priority/minimum, unchanged;
    - `workingLoadResolution: RESOLVE_FOR_SUBSTITUTE_EXERCISE`;
    - `warmUpLoadResolution: RESOLVE_FOR_SUBSTITUTE_EXERCISE`, or `null`
      when there are no warm-ups.
- **`session[]`** — the canonical slot identity for a later
  preview/fingerprint, in authored order: `authoredExerciseId`,
  `effectiveExerciseId` and `substituted`. Unaffected slots are identical
  to the authored ones.

### REVIEW_REQUIRED

Returned when any unavailable exercise is unresolved. It carries:
- `reasonCode` — the first unresolved exercise's reason, in authored order;
- `unresolved[]` — `{ plannedExerciseId, authoredExerciseId, reasonCode }`;
- `unavailablePlannedExerciseIds`.

No partial replacements are ever returned.

## 5. Candidate selection (per unavailable exercise, fixed order)

| # | Rule | Reason when nothing is left |
|---|---|---|
| 1 | The exercise is `LOCKED` | `LOCKED_EXERCISE_UNAVAILABLE` |
| 2 | There are no curated candidates | `NO_CURATED_SUBSTITUTE` |
| 3 | Drop the exercise itself, athlete-blocked candidates, and any needing unavailable equipment | `NO_AVAILABLE_SUBSTITUTE` |
| 4 | Keep `ROLE_EQUIVALENT` only (`ROLE_COMPATIBLE` is never auto-selected) | `NO_EQUIVALENT_SUBSTITUTE` |
| 5 | Keep `PRESERVE_WORKING_PRESCRIPTION` only | `UNSUPPORTED_PRESCRIPTION_COMPATIBILITY` |
| 6 | Drop identities already in the session: any authored exercise, plus substitutes chosen earlier for an earlier slot. Slots are never merged. | `SUBSTITUTE_CONFLICT` |
| 7 | The lowest `substitutionPriority` must be unique | `AMBIGUOUS_SUBSTITUTION` |

- **Order of work:** unavailable exercises are processed sequentially in
  authored order. This is explainable and is not a global optimization.
  A sequential conflict fails closed with SUBSTITUTE_CONFLICT.
- **Never used for ranking:** compatibility is never inferred from names,
  muscles, similarity or AI, and never from Available-Time priority.

## 6. Load and history isolation

- **Load:** never copied, for working or warm-up sets. A machine load is
  not a barbell or dumbbell load. The substitute's load comes later from
  its own history, the Load Resolver, available increments, or a
  no-history flow. There is no load conversion math.
- **History:** the substitute keeps its OWN `exerciseId`, and performance
  belongs to the exercise actually performed. A later immutable
  prescription will carry both the authored and the performed identity.
- **Warm-ups:** structure is preserved; load is re-resolved later.

## 7. Determinism and boundaries

- **Pure:** no clock, randomness, DB, network, filesystem or id generation,
  and the input is never mutated.
- **Order-independent:** candidate and exercise row order don't matter;
  explicit priority and authored order decide.
- **Same answer for every mode:** GUIDED/ADAPTIVE/EXPERT; COACHED remains
  an overlay.
- **No other outputs:** no progression, regression, deload or PR, and no
  Athlete Memory.
- **Invalid input:** structurally invalid input is a typed `err`, for
  example a duplicate order, a non-positive priority, a duplicate
  candidate, an empty id, or an Available-Time minimum above the working
  set count.
- **Dependencies:** `@vostivo/domain` types only, enforced by
  `boundaries:check` and a test.

## 8. Evidence

`policy.test.ts`: 34 tests covering the full matrix 1–38, plus edge cases:
- the empty equipment context;
- a LOCKED but available exercise;
- a tie broken by equipment;
- exercise row order;
- a sequential cross-slot conflict;
- top-level reason precedence;
- the no-warm-up case;
- validation errors.

The full training-engine suite is 174 tests, all passing.

## 9. Not in Slice A

- a substitution catalog in the DB;
- equipment and Gym Profile persistence;
- an API preview;
- the Today card or Active Workout Swap UI;
- application persistence;
- the substituted immutable START;
- load conversion;
- permanent plan edits;
- machine-occupied automation.

## 10. Slice B fail-closed rule (recorded for the next slice)

If a target PlannedWorkout contains any exercise whose equipment
requirements cannot be authoritatively resolved, because its identity is
null or unknown to the Exercise & Equipment Reference Catalog V1, the
server preview must NOT silently declare that exercise available. V1 fails
closed to REVIEW_REQUIRED with unsupported-identity semantics; the exact
API reason mapping belongs to Slice B.

Curated Substitution Seed V1 adds 14 ROLE_EQUIVALENT and 8 ROLE_COMPATIBLE
edges. ROLE_EQUIVALENT means the substitute may be automatically
RECOMMENDED for a temporary session substitution; ROLE_COMPATIBLE is a
review/manual alternative only. Neither transfers load or history.

From the real catalog:
- **ADJUST_SESSION:** bench-press, overhead-press, lat-pulldown,
  romanian-deadlift and barbell-row can be resolved automatically.
- **REVIEW_REQUIRED / NO_EQUIVALENT_SUBSTITUTE:** back-squat, leg-press,
  hack-squat and deadlift, because they have only compatible edges.
- **REVIEW_REQUIRED / NO_CURATED_SUBSTITUTE:** face-pull, leg-curl,
  incline-dumbbell-press and bulgarian-split-squat.

See EXERCISE-EQUIPMENT-REFERENCE-CATALOG-V1.md §10.

## 11. Slice B — read-only server preview (2026-10-10)

### 11.1 Locked rules

```text
CLIENT SENDS COMPLETE SESSION AVAILABLE-EQUIPMENT INVENTORY.
SERVER OWNS EXERCISE REQUIREMENTS AND SUBSTITUTION CANDIDATES.
ADAPTATION REQUIRES ATHLETE-LOCAL TODAY.
EFFECTIVE SCHEDULE WINS OVER AUTHORED DATE.
UNKNOWN EXERCISE IDENTITY FAILS CLOSED.
PREVIEW IS READ-ONLY.
CATALOG VERSION PARTICIPATES IN PREVIEW STALENESS.
```

### 11.2 Endpoint and request

`POST /api/v1/plan/equipment-adaptation-preview`

```json
{ "plannedWorkoutId": "…", "catalogVersion": "exercise-equipment-catalog/v1", "availableEquipmentIds": ["…"] }
```

- **Strict schema:** with `forbidNonWhitelisted`, any other field returns
  400. That covers substitutes, replacements, tiers, priorities,
  requirements, names, locks, blocks, the athlete id, the date and the
  timezone.
- **`availableEquipmentIds` is the COMPLETE session inventory.** Anything
  not listed is unavailable, which is fail-closed. `[]` is valid and means
  only equipment-free exercises are performable.
- **Inventory handling:** each id must be a canonical catalog id, else 400
  `UNKNOWN_EQUIPMENT_ID` listing the unknown ids. Duplicates collapse and
  the list is sorted, so request order never matters.
- **Catalog version:** `catalogVersion` must equal the server's catalog
  version, else 409 `EQUIPMENT_CATALOG_VERSION_MISMATCH`. **From this slice
  on, catalog version discipline is mandatory:** any incompatible catalog
  change requires a version bump, because the version takes part in the
  preview and its fingerprint.

### 11.3 Server-derived pipeline

1. Ownership join: the workout must belong to the actor's own profile.
   Not found and not owned are the same 404.
2. Schedule Calendar Authority: athlete-local today via
   `requireAthleteTimeZoneDate`. A missing or invalid zone returns 409
   `TRAINING_TIME_ZONE_REQUIRED`; the legacy UTC fallback is never used.
3. ACTIVE ProgramVersion and a strict `IN_CURRENT_BLOCK`. The workout must
   be in that version and block, and be PLANNED or AVAILABLE.
4. Its EFFECTIVE date (`resolveEffectiveScheduledDate`, the missed-workout
   overlay) must equal today. A rolled-forward workout is applicable with
   its same PlannedWorkout id, whatever its authored past date.
5. No canonical session (Occurrence Authority): this is a pre-start preview
   only.
6. Exercise identity:
   - every PlannedExercise is resolved through the catalog
     (`catalogEquipmentFacts`);
   - ANY null or unknown `exerciseRef` gives REVIEW_REQUIRED
     `UNSUPPORTED_EXERCISE_IDENTITY` for those exercises;
   - the engine is not run, nothing is partially adjusted, and nothing is
     name-matched.
7. Engine input:
   - requirements and curated candidates come from the catalog only;
   - the inventory comes from the request;
   - the set structure (types, rep targets, rest) and the Available-Time
     priority/minimum come from the authored plan;
   - authored load is not passed at all.
8. The unchanged `equipment-adaptation/v1` produces the result.
9. Structured response; no prose.

**Not-applicable cases** return 409 with body
`{ message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode }`, where
`reasonCode` is one of `SCHEDULE_CONTEXT_UNRESOLVED`,
`OUTSIDE_CURRENT_BLOCK`, `NOT_TODAYS_WORKOUT` (future, past and not moved,
or a carryover with no date), `WORKOUT_RESOLVED` or
`WORKOUT_ALREADY_STARTED`. Nothing is ever moved: scheduling is not
equipment adaptation.

An authored Available-Time minimum above the working-set count, or an
invalid rep range, returns 422 `EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION`.

### 11.4 Locks and blocks

Inspected 2026-10-10: **no persisted lock and no athlete exercise
block/preference exists.** So every slot is `ALLOW_TEMPORARY` (no slot is
currently locked), and the athlete-blocked set is empty. Both are
server-owned constants, never client input. Future program/coach locks and
athlete preferences will replace them and remain authoritative.

### 11.5 Response (`EquipmentAdaptationPreviewResponseV1`)

**Common fields:**
- `schemaVersion` (`equipment-adaptation-preview/v1`), `policyVersion`,
  `catalogVersion`;
- `athleteLocalDate`, `plannedWorkoutId`, `workoutName`;
- `availableEquipmentIds` (canonical);
- `previewFingerprint`.

**By result:**
- **NO_CHANGE / `ALL_EQUIPMENT_AVAILABLE`:** `replacements: []`.
- **ADJUST_SESSION / `TEMPORARY_EQUIPMENT_UNAVAILABLE`:** `replacements[]`,
  in authored order. Each has:
  - `plannedExerciseId`, `order`;
  - `authoredExerciseRef` and `authoredExerciseName` (the authored label);
  - `substituteExerciseRef` and `substituteExerciseName` (the catalog
    label);
  - `reasonCode`, `prescriptionPolicy: PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD`;
  - `prescription`: `workingSetCount`, sets with id, order, type, reps and
    rest but **no load**, `availableTime`, and
    `loadResolution: RESOLVE_FOR_SUBSTITUTE_EXERCISE`.
- **REVIEW_REQUIRED:** the authored-order primary `reasonCode` plus
  `unresolved[]` (`plannedExerciseId`, `order`, ref or null, name,
  reason). Never partial replacements.

### 11.6 Fingerprint

SHA-256 of `canonicalStringify` over:
- the fingerprint, preview and policy schema versions;
- `catalogVersion`;
- the athlete profile, ProgramVersion, block and planned workout ids;
- `athleteLocalDate`, the effective scheduled date, and the canonical
  occurrence state;
- per exercise in authored order: id, ref, order, substitution policy,
  Available-Time values, and sets (id, order, type, reps, rest);
- the blocked set;
- the sorted inventory;
- the semantic decision.

It excludes display labels, request order, the clock instant and random
ids. It changes with equipment, prescription, identity, ordering, lock or
block state, effective-today assignment, local date, catalog version,
policy version and the decision. It is not persisted yet (Slice C) and is
not an auth token.

### 11.7 Read only

Only SELECTs. Real-Postgres proof covers every outcome (ADJUST, NO_CHANGE,
REVIEW, not applicable and validation errors): no session, claim,
ProgramVersion or plan row change, no missed-workout, Available-Time or
equipment application, no progression decision or application, no command
receipt, no pg-boss job. Repeated previews are identical.

### 11.8 Interoperability

- **Missed Workout:** the overlay's effective date decides "today"; the
  same PlannedWorkout id is used; the overlay is untouched.
- **Available-Time:** not composed in this slice. A later Available-Time
  use targets the same planned workout id. Composing immutable
  prescription adjustments belongs to Slice C+.
- **Progression:** never run; a substitute is not a progression event.

### 11.9 Evidence

- **`equipment-adaptation-preview.test.ts`** (20, real catalog): items
  1–22, the fingerprint sensitivity matrix and the 422 case.
- **`plan.controller.test.ts`:** auth, 18 strict-body rejections, and the
  409, 404 and 400 mappings.
- **`equipment-adaptation-preview.integration.test.ts`** (14, real
  Postgres): items 23–45, plus SKIPPED, outside-block, catalog version,
  unknown equipment and unsupported identity cases.
- **Contracts:** `equipment-adaptation-preview.test.ts` (type-level).


## 12. Slice C — durable TODAY_ONLY application + START (2026-10-11)

Status: CLOSED (START integrity closure fix accepted).

### 12.1 Locked rules

- PREVIEW -> explicit apply -> server re-derivation -> fingerprint must
  match -> durable record -> START consumes the effective prescription.
- AUTHORED PLAN IS NEVER MUTATED: ProgramVersion, PlannedWorkout,
  PlannedExercise, PlannedSet, catalog and Gym Profile are untouched.
- AUTHORED IDENTITY != PERFORMED IDENTITY: the slot
  (`prescriptionExerciseId`) stays the authored PlannedExercise; the
  performed `exerciseRef` is the substitute; `substitution` keeps the
  authored identity.
- LOAD IS NEVER TRANSFERRED: a substitute's load comes only from its own
  history, or it has no prescribed load.
- A SUBSTITUTE NEVER COUNTS AS THE AUTHORED EXERCISE for history or
  progression.
- **CLIENT CANNOT CHANGE EXERCISE IDENTITY AT START.**
- **EVERY EXERCISE IDENTITY CHANGE REQUIRES SERVER-VALIDATED SUBSTITUTION
  PROVENANCE.**
- **AN ACTIVE EQUIPMENT APPLICATION CANNOT BE SILENTLY BYPASSED BY STARTING
  THE AUTHORED EXERCISE.** After an explicit Apply, the normal Start
  Workout starts the effective, equipment-adjusted prescription. Getting
  the original exercise back requires an explicit future revert/cancel
  decision (not built; today: apply a NO_CHANGE preview before START).
- **CANONICAL START LEAVES NO APPLICABLE ACTIVE EQUIPMENT APPLICATION
  BEHIND.** (Closure fix, 2026-10-12: §12.5.)

### 12.2 Apply endpoint

`POST /api/v1/plan/equipment-adaptation-apply` (strict body, unknown
fields -> 400):

```text
{ plannedWorkoutId, previewFingerprint (64 lowercase hex), catalogVersion,
  availableEquipmentIds }
```

No replacements, candidates, substitute ids, names, sets, loads, priority,
lock/block state, Available-Time decision, date, time zone or athlete id.
The inventory is re-sent because no preview is stored and no Gym Profile
exists. Without it the server has nothing to re-derive from. The
fingerprint binds it, so a different inventory is STALE.

Pipeline, in ONE transaction:

1. Take the planned-occurrence advisory lock
   (`pg_advisory_xact_lock("planned-occurrence:<user>:<plannedWorkout>")`).
   START takes the same lock.
2. Idempotent replay: if this user + workout + fingerprint already has an
   ACTIVE or CONSUMED row, return it.
3. `deriveEquipmentAdaptation` re-derives everything with the same code as
   the preview: owned target (404), catalog version (409), inventory
   (400), explicit time zone (409), ACTIVE version + current block,
   effective date == athlete-local today, pre-start, authored
   prescription, curated candidates.
4. Fingerprint mismatch -> `409 EQUIPMENT_PREVIEW_STALE`.
5. `REVIEW_REQUIRED` -> `409 EQUIPMENT_ADAPTATION_REVIEW_REQUIRED
   {reasonCode}`. Not-applicable cases keep their Slice B 409 codes.
6. Supersede the ACTIVE row, then insert the new ACTIVE row.

Response (`EquipmentAdaptationApplyResponseV1`, compact): `applicationId`,
`scope`, `plannedWorkoutId`, `athleteLocalDate`, `previewFingerprint`,
`status`, `result`, and `replacements` as
`{plannedExerciseId, order, authoredExerciseRef, substituteExerciseRef,
substituteExerciseName}`, plus `appliedAt`.

### 12.3 Persistence (migration 0020)

Table `app.equipment_adaptation_applications`.

**Columns:**

- **Identity:** `user_id`, `athlete_profile_id`, `planned_workout_id`,
  `program_version_id`, `training_block_id`, all real FKs.
- **Scope:** `scope = TODAY_ONLY`, `athlete_local_date`,
  `training_time_zone`.
- **Versions:** `preview_schema_version`, `policy_version`,
  `catalog_version`, `preview_fingerprint`.
- **Data:** the canonical `available_equipment_ids`, `result`, and the
  server-derived `replacements`.
- **Lifecycle:** `status` (ACTIVE / SUPERSEDED / CONSUMED),
  `supersedes_application_id` (self FK), `superseded_at`,
  `consumed_by_workout_session_id` (FK, UNIQUE), `consumed_at`.
- **Audit:** `applied_by_user_id`, `applied_at`.

**Constraints:**

- Partial UNIQUE (user, planned workout) WHERE ACTIVE, so there is ONE
  effective application per occurrence.
- CHECKs on superseded consistency, consumed consistency and
  `NO_CHANGE ⇔ empty replacements`.

**Append/audit semantics:** rows are never deleted. Only these
transitions exist:

- ACTIVE -> SUPERSEDED: a newer apply, or the canonical START claimed the
  occurrence while the row no longer applied (another day, a changed plan),
  so it was retired UNUSED (`superseded_at` set; no newer row points at
  it). No new status, no migration.
- ACTIVE -> CONSUMED: the canonical START used it (ADJUST_SESSION, or an
  applicable NO_CHANGE clear).

**Change/cancel before START:** apply a new preview. Applying a NO_CHANGE
preview ("everything is available today") is the auditable clear: it
supersedes the previous row, and the Workout Preview returns to the
authored workout. Re-applying an older preview creates a new row; it never
resurrects a superseded one.

### 12.4 Effective prescription (Workout Preview = what START snapshots)

`PlanReadService.getWorkoutPreview` (pre-start only) calls
`resolveEffectiveEquipmentSubstitutions`. It uses the ACTIVE
ADJUST_SESSION row only if re-deriving NOW with the row's own stored
inventory and catalog yields the row's exact fingerprint. Otherwise it
silently uses the authored prescription and writes nothing. This covers:

- another athlete-local day (TODAY_ONLY);
- a moved effective date;
- a changed authored prescription;
- a started occurrence;
- the workout falling outside the block.

**Composition order (documented and tested):**

```text
schedule authority (effective date)
 -> authored prescription (+ progression effective-load overlay)
 -> TODAY_ONLY equipment substitution (identity + the substitute's own load;
    set ids / types / reps / rest unchanged)
 -> Available-Time structural selection at START (by set ids)
```

Available-Time depends only on set structure and ids, so the two commute.
Equipment-then-time and time-then-equipment produce the same snapshot
structure, and both verify (EQC-18).

**Substituted exercise:**

- `exerciseRef` / `displayName` are the substitute's (catalog name).
- `substitution` carries:
  - `kind: TEMPORARY_EQUIPMENT` and
    `reasonCode: TEMPORARY_EQUIPMENT_UNAVAILABLE`;
  - `authoredExerciseRef` and `authoredDisplayName`;
  - `equipmentApplicationId`;
  - `policyVersion` and `catalogVersion`.
- **WORKING load:** the substitute's own most recent exposure, if that
  session's completed WORKING sets share one uniform external load. There
  is no increase and no conversion. Otherwise it is `null` (the athlete
  chooses, guided by the substitute's own Previous).
- **WARM_UP load:** always `null`.

The display `exercises` carry the same name, load and `substitution`. The
contract change is additive and optional. Mobile already passes extra
prescription fields through, so it needed no change.

### 12.5 START (local-first, verified server-side)

`applyStartWorkoutSession` runs these steps:

1. `resolveStartProvenance` (owned workout, only its own exercise/set ids).
2. For PLANNED provenance, the planned-occurrence lock. Everything below
   runs inside it, in the START transaction.
3. `decideEquipmentSubstitutionStart` — START EXERCISE IDENTITY INTEGRITY,
   decided BEFORE any write. A rejection writes no session, no claim, no
   Available-Time row and no application change.
4. Then the Available-Time decision, the session insert and the claim, as
   before.
5. Lifecycle, only when this START created the CANONICAL claim (same
   transaction): the governing ACTIVE row -> CONSUMED by this session; an
   ACTIVE row that does not apply -> SUPERSEDED (retired unused).
6. A duplicate START replay is unchanged (receipt -> DUPLICATE). A retried
   apply of a consumed fingerprint returns the CONSUMED row. A new apply
   after START is `NOT_APPLICABLE WORKOUT_ALREADY_STARTED`.

**Governing application** (the server's authority for this occurrence):

- **Already started** (a canonical claim exists): the application CONSUMED
  by the canonical session, if any. A SECONDARY START (another device) must
  perform that same replacement reality.
- **Not started:** the ACTIVE row (ADJUST_SESSION or NO_CHANGE) if
  re-deriving it reproduces its fingerprint at the command's `startedAt`
  (an offline START that really happened on the application day and syncs
  later) **or** at server `now` (a client cannot escape an applicable
  application by lying about `startedAt`).
- Otherwise none.

**Per-slot rule** (snapshot read strictly by the domain's
`readSnapshotExerciseIdentities`; malformed shape -> REJECTED):

- A slot the governing application replaces: `exerciseRef` == the durable
  substitute, and `substitution` is exactly:
  - `kind TEMPORARY_EQUIPMENT`, `reasonCode TEMPORARY_EQUIPMENT_UNAVAILABLE`;
  - `authoredExerciseRef` == the durable replacement == the live authored
    PlannedExercise;
  - `authoredDisplayName` == the live PlannedExercise display name;
  - `equipmentApplicationId` == the governing application;
  - `policyVersion` == `equipment-adaptation/v1` == the row's;
  - `catalogVersion` == the row's;
  - no missing, extra or null field.
- Every replaced slot must appear exactly once: omitted, duplicated,
  authored (bypassing the application) or another substitute -> REJECTED.
- Every other slot: no `substitution` key at all, and `exerciseRef` == the
  live authored PlannedExercise (including `null` for a freeform one). Any
  other value — an arbitrary exercise, the curated substitute without
  provenance, a well-formed but fake substitution object — is REJECTED.
- Duplicate slots are REJECTED. An extra slot of another workout or with an
  invented id is already REJECTED by provenance.
- Omitting a non-replaced slot changes no identity and stays accepted
  (pre-existing behavior; Available-Time removes sets/exercises this way).
- UNPLANNED START: any `substitution` key -> REJECTED; its ad-hoc
  exercises are otherwise unchanged.

Consequences: a SUPERSEDED application's exact snapshot (offline START from
an older preview) and a substituted snapshot started on another day are now
REJECTED — they are no longer the server's effective identity. The athlete
re-reads the Workout Preview and starts again (no work is lost: nothing was
accepted).

**Race:** apply and START serialize on the same advisory lock. START first
-> apply is `WORKOUT_ALREADY_STARTED`. Apply first -> an authored START is
REJECTED, the equipment-adjusted START then succeeds and consumes it. Never
an ACTIVE row after the claim, never two replacement realities (EQC-10, 6
rounds).

### 12.6 Identity, history, progression

- **`performed_exercises`:** `exercise_ref` is the substitute and
  `prescription_exercise_id` is the authored slot. History, Previous and
  `WorkoutHistoryService` therefore attribute the work to the substitute.
  The authored exercise's history is unchanged (EQC-19).
- **`ProgressionEvaluationService`:** if the anchor's snapshot exercise
  carries `substitution`, it returns
  `TEMPORARY_SUBSTITUTION_NOT_EVALUATED`, and the worker treats that as a
  final skip (no decision, no retry). The session's other exercises still
  evaluate.
- **`ensureApplicationForDecision`:** a decision whose `exerciseRef`
  differs from the slot's authored `exerciseRef` -> `NO_PLAN_CONTEXT`.
  This is a defense in depth: a substitute can never create a progression
  application for the authored slot.

### 12.7 Staleness matrix

| Change after preview                         | Apply                    | Workout Preview / START       |
| -------------------------------------------- | ------------------------ | ----------------------------- |
| inventory differs from the fingerprint       | 409 STALE                | —                             |
| authored sets/reps/rest/exercise changed     | 409 STALE                | authored (row ignored)        |
| catalog version                              | 409 CATALOG_VERSION_MISMATCH | authored                   |
| next athlete-local day                       | 409 NOT_TODAYS_WORKOUT   | authored; substituted START REJECTED; canonical START retires the row |
| missed-workout overlay moved today's workout | 409 NOT_TODAYS_WORKOUT / STALE | authored                |
| occurrence started / completed               | 409 WORKOUT_ALREADY_STARTED | snapshot is truth          |
| ProgramVersion / block no longer current     | 409 NOT_APPLICABLE       | authored                      |
| newer apply                                  | supersedes               | the newer row; older snapshot REJECTED |

Available-Time is decided at START, not before it, so it is not pre-START
state that the equipment fingerprint covers. Its own START verification
stays authoritative.

### 12.8 Evidence

- **`equipment-adaptation-apply.integration.test.ts`** (24, real Postgres
  + real pg-boss, fixed server `now`), EQC-01..21:
  - apply data, compactness, and no authored mutation;
  - replay and a 5-way concurrent apply;
  - supersede, NO_CHANGE clear, and the audit chain;
  - REVIEW_REQUIRED and the staleness cases;
  - BOLA and Missed Workout interop;
  - started/completed occurrences, and the apply-vs-START race;
  - the effective Workout Preview, and substitute-own load;
  - START consume and replay, and fail-closed tampering (9 variants +
    unplanned);
  - superseded / other-day / secondary STARTs;
  - composition in both orders;
  - history and progression isolation (the session's non-substituted
    exercise still evaluates and persists a decision);
  - START identity integrity (closure fix): no application (9 identity
    changes incl. fake provenance), ACTIVE application (14 bypass /
    inconsistency variants), `startedAt` lie, other-day retire, superseded
    snapshot, secondary START, Available-Time cannot change identity,
    Missed Workout moved occurrence START + consume, zero ACTIVE rows after
    every canonical START.
- **`plan.controller.test.ts`:** apply auth, 18 strict-body rejections,
  and the 409/404 mappings.
- **`equipment-substitution.test.ts` (domain, 21):** the strict snapshot
  identity reader.
- **`progression-application.integration.test.ts`:** the mismatching
  exerciseRef -> NO_PLAN_CONTEXT case.
- **`progression-evaluate-session.job.integration.test.ts`:** the
  substituted exercise is a final skip.

### 12.9 Not in Slice C / limitations

- No mobile UI.
- No Gym Profile, persisted locks or blocks, or manual ROLE_COMPATIBLE
  choice.
- No explicit revert/cancel UX after Apply (a NO_CHANGE apply before START
  is the only clear).
- A secondary START's provenance is compared with the CURRENT live authored
  PlannedExercise (display name included). PlannedExercise is immutable in
  V1, so this cannot drift today.
- Rows from before the closure fix that an authored START already left
  ACTIVE (dev data only) are not migrated; they no longer apply anywhere.
- The substitute load resolver is deliberately conservative (last uniform
  exposure). It does not apply Load Resolver increments or Loading
  Capabilities.
- `vostivo_manual` is migrated to 0020 (21/21, non-destructive, 2026-10-12).

## 13. Slice D — athlete mobile UX (2026-10-12)

Status: CLOSED / PASS — human acceptance on Vostivo_Light, 2026-10-17 (§13.6).

### 13.1 Locked UX principles

```text
START REMAINS PRIMARY.
EQUIPMENT IS A CONTEXTUAL TODAY-ONLY DECISION.
MOBILE NEVER OWNS THE CANONICAL EQUIPMENT CATALOG.
USER SELECTS THE COMPLETE AVAILABLE INVENTORY FOR THIS SESSION.
PREVIEW BEFORE APPLY.
APPLY NEVER AUTO-STARTS.
NO OPTIMISTIC SUBSTITUTION.
SERVER EFFECTIVE PRESCRIPTION DRIVES START.
```

### 13.2 Options endpoint (read-only, no migration)

`GET /api/v1/plan/equipment-adaptation-options?plannedWorkoutId=` (strict
query; any other parameter -> 400).

- **Authority:** `resolveEquipmentAdaptationTarget`, the SAME
  applicability check the preview/apply derivation now calls (it was split
  out of `deriveEquipmentAdaptation`, behaviour unchanged): owned (404),
  explicit time zone (409 `TRAINING_TIME_ZONE_REQUIRED`), ACTIVE version +
  current block, effective date == athlete-local today (a Missed Workout
  moved workout keeps its id and is today's), pre-start (409
  `EQUIPMENT_ADAPTATION_NOT_APPLICABLE` + reasonCode).
- **Options** (`computeEquipmentAdaptationOptions`, pure): the canonical
  catalog equipment required by the workout's planned exercises (`PLANNED`)
  plus the extra equipment of their curated substitutes, every explicit
  edge, one hop (`SUBSTITUTE`). PLANNED wins when both apply, no duplicates,
  catalog declaration order within each group. A null or unknown exercise
  identity contributes nothing. No candidates, tiers or ranking.
- **`currentApplication`:** today's still-applicable ACTIVE application
  (fingerprint re-derivation match), with its durably stored declared
  inventory. The sheet may start from it; otherwise nothing is selected.
- Only SELECTs.

### 13.3 Mobile flow (`apps/mobile/src/equipment/`)

Same architecture as Available-Time / Missed Workout: a pure flow
(`equipment-flow.ts`), a framework-free controller
(`equipment-controller.ts`), an API client and a thin RN sheet.

- **Today:** a quiet "Equipment" action next to "Adjust time", with the
  same eligibility (today's planned workout, not started, Resume wins).
  Start Workout stays the Hero's single primary button. When the server's
  effective Workout Preview carries temporary-equipment substitutions,
  Today shows a quiet line "Equipment adjusted · N exercises" — read from
  the server on every Today reload, never set optimistically.
- **Selection sheet** "Equipment available today": the server's options as
  full-width rows with a check box + label (not colour-only). First use
  selects nothing; "Everything available" and "Clear all" are explicit. The
  selection IS the complete `availableEquipmentIds`; unselected = not
  available. Nothing is persisted.
- **"Review changes"** sends only `{plannedWorkoutId, catalogVersion,
  availableEquipmentIds}` and reads the effective Workout Preview alongside.
  While loading, the selection is kept and duplicate submits are ignored.
- **ADJUST_SESSION:** "Adjust this workout" — changed exercises only,
  authored → substitute (server names), "Equipment unavailable today",
  "N × reps stays the same", "Sets, reps and rest stay the same. Load is
  resolved for the replacement." No load is shown. "Apply changes" / "Not
  now" / "Edit equipment".
- **NO_CHANGE:** "No changes needed". If the effective workout is NOT
  adjusted: "Done" (no request). If it IS adjusted: "Use original workout"
  = the Slice C apply of the NO_CHANGE preview (the explicit clear).
- **REVIEW_REQUIRED:** "This workout needs review" + a calm reason (never
  the enum); "Edit equipment" / "Not now"; never Apply.
- **Apply** sends exactly the shown preview's fingerprint, catalog version
  and the same inventory. Success closes the sheet and re-reads Today;
  nothing starts.
- **Stale** (`EQUIPMENT_PREVIEW_STALE` / `REVIEW_REQUIRED` on apply): never
  re-sent; the same inventory is previewed again and shown with "Workout
  changed. Review the updated recommendation." — a NEW explicit tap is
  required. NOT_APPLICABLE / 404 closes the sheet and refreshes Today.
- **Offline / 5xx apply:** the review stays open ("Couldn't update the
  workout right now.", Retry / Not now); Retry re-sends the same request.
- **Catalog mismatch / unknown id:** the options are reloaded, the
  selection keeps only still-offered ids, and "Review changes" is required
  again.
- **Time zone required:** "Set your training timezone to adjust
  equipment." with "Try again" = Missed Workout's existing bootstrapper
  retry.

### 13.4 START, Active Workout, composition

- Start Workout is unchanged: it snapshots the server's effective
  (equipment-adjusted) Workout Preview. Mobile never builds or merges a
  prescription. "Adjust time" selects sets from the same effective preview,
  so the composition order of §12.4 holds on device.
- Active Workout shows the performed substitute (name, own load or the
  empty state). Previous performance and the load prefill are keyed by the
  performed `exerciseRef` only (`active-workout-presentation.ts`, extracted
  unchanged and now unit-tested). The authored exercise's history or load
  never reaches the substitute.
- Plan is unchanged (no established per-session adaptation badge for this).

### 13.5 Human acceptance fixture

`EQUIPMENT_ADAPTATION_FIXTURE=true pnpm --filter @vostivo/database
db:seed:dev-plan` (see SETUP.md): Upper Body A = Bench Press 3 x 8–12 +
Overhead Press 2 x 8–12 on the athlete-local today (Europe/Prague), GUIDED,
nothing started. Dry-run on `vostivo_dev` (2026-10-12, throwaway athlete,
removed afterwards): options = barbell, barbell rack, flat bench (PLANNED),
adjustable bench, dumbbells (SUBSTITUTE); inventory dumbbells + flat bench +
adjustable bench → Bench → Dumbbell Bench Press, OHP → Seated Dumbbell
Overhead Press; after Apply both substitutes have no prescribed load; the
barbell + rack + flat bench inventory previews NO_CHANGE.

### 13.6 Evidence

- Mobile: `equipment-controller.test.ts`, `equipment-flow.test.ts`,
  `equipment-start.test.ts` (real SQLite START) — 46 tests.
- API: `equipment-adaptation-options.test.ts` (5), controller route block
  in `plan.controller.test.ts`, real Postgres EQD-01..04 in
  `equipment-adaptation-apply.integration.test.ts`.
- Human acceptance (Vostivo_Light, `EQUIPMENT_ADAPTATION_FIXTURE`,
  2026-10-17) — PASS:
  - The preview proposed Bench Press -> Dumbbell Bench Press and Overhead
    Press -> Seated Dumbbell Overhead Press.
  - Sets, reps and rest were preserved. The authored 60 kg / 30 kg loads
    were not transferred.
  - Not now persisted nothing. Apply did not auto-start. Today showed
    "Equipment adjusted · 2 exercises".
  - The NO_CHANGE "Use original workout" revert worked.
  - After re-applying and starting, Active Workout showed Dumbbell Bench
    Press and Seated Dumbbell Overhead Press. PREV and the load fields were
    empty for both, no authored Bench/OHP history was shown, and the bottom
    navigation was hidden.

### 13.7 Known limitations

- No Swap inside Active Workout, no manual ROLE_COMPATIBLE choice, no Gym
  Profile, no saved equipment.
- Plan shows no equipment badge.
- The Today "Equipment adjusted" line needs one extra Workout Preview read
  per Today reload.

