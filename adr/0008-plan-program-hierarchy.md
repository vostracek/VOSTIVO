# ADR-0008: Plan/Program hierarchy — derived active version, and the WorkoutPrescriptionV1 rep-range boundary

- **Status**: Accepted
- **Date**: 2026-09-05

## Context

The Plan & Workout Prescription vertical slice introduces the previously
deferred Intent hierarchy (`Program` -> `ProgramVersion` ->
`TrainingBlock` -> `TrainingCycle` -> `PlannedWorkout` ->
`PlannedExercise` -> `PlannedSet`) and must produce the already-locked
`WorkoutPrescriptionV1` (Workout Data Integrity, ADR-0007) from it. Two
real decisions came up that are not just normal implementation detail.

## Decision 1: the active `ProgramVersion` is derived, never a stored pointer

`ProgramVersion` is effectively immutable once `ACTIVE` — a future
structural change creates a new version rather than mutating this one.
The natural way to model "which version is current" is a
`Program.activeProgramVersionId` pointer, but that creates a circular
foreign-key relationship (`programs -> program_versions -> programs`) and
a redundant source of truth (the pointer could disagree with which
version's `status` actually says `ACTIVE`).

**Decision**: no `activeProgramVersionId` column exists on `programs` at
all. "The active version" is `program_versions WHERE program_id = ? AND
status = 'ACTIVE'`, and a partial unique index
(`program_versions_one_active_per_program`, `UNIQUE (program_id) WHERE
status = 'ACTIVE'`) makes "at most one active version per program" a real
database-enforced invariant rather than application-layer discipline.

### Alternatives considered

- **A stored `activeProgramVersionId` pointer**: rejected — the circular
  FK and the two-sources-of-truth problem above are both avoidable, and
  Postgres's partial unique index gives strictly *stronger* correctness
  than an application-checked pointer would.

### Consequences

Easier: one query answers "what's active," backed by a real constraint.
Harder: any future feature that wants O(1) "give me the active version
id" without a `status` filter needs a small index-assisted query instead
of a direct FK dereference — a negligible cost for the correctness gained.

## Decision 2: `PlannedSet` rep range and `WorkoutPrescriptionV1.targetReps` — originally a documented lossy mapping, corrected in place by the Plan Contract Integrity Fix Pass

**Status of this decision: superseded/resolved, 2026-09-05.** The
original decision recorded here (see history below) shipped a real,
acknowledged information loss — a `PlannedSet` rep range was resolved down
to its minimum bound when building `WorkoutPrescriptionV1`. On review,
this was rejected as unacceptable: the prescription snapshot's entire
purpose is to be the immutable record of Plan intent, and silently
discarding the upper bound of a "8–12 reps" prescription is exactly the
kind of loss that boundary exists to prevent.

**Resolution**: introduced `RepTargetV1`
(`packages/domain/src/rep-target.ts`), a discriminated union —
`{kind:"EXACT",reps}` | `{kind:"RANGE",minReps,maxReps}` — and changed
`PrescribedSetV1.targetReps` (ADR-0007) to use it in place, replacing the
plain `number | null`. This *is* the WDI contract change that the original
decision below deferred — after inspecting every consumer (domain
validation, the Plan→Prescription transformation, the WDI session
snapshot, local SQLite, the API/contracts layer, seed data, and all
tests), no genuine compatibility blocker existed: `WorkoutPrescriptionV1`
had no production users, was not yet released, and is only ever persisted
as opaque JSONB with no structured-column dependency on its shape. An
in-place correction was therefore safe and preferable to a `V2` — see
"`RepTargetV1`" in `docs/architecture/PLAN-PRESCRIPTION.md` for the full
before/after and the native re-verification evidence. No database
migration was needed: the existing two nullable integer columns
(`target_reps_min`/`target_reps_max`) are reinterpreted via
`repTargetFromRange`/`repTargetToRange` rather than replaced.

The alternatives-considered and consequences below are preserved as the
historical record of the original (now superseded) decision.

### Original decision (superseded)

This slice's spec explicitly asks for rep-range support (e.g. "8–12
reps"). The already-locked `WorkoutPrescriptionV1.PrescribedSetV1
.targetReps` (ADR-0007) is a single nullable number. Modifying that wire
contract was explicitly out of scope unless there is a *real*
incompatibility — and there is one here.

`PlannedSet` gets `targetRepsMin`/`targetRepsMax` (a real range).
`createWorkoutPrescriptionFromPlannedWorkout`
(`packages/domain/src/plan/prescription-builder.ts`) maps a range down to
`targetRepsMin` when building a `WorkoutPrescriptionV1` — a conservative
"at least N reps" reading. This is a real, acknowledged information loss
at that one boundary, documented in both `planned-set.ts` and
`docs/architecture/PLAN-PRESCRIPTION.md`, not a silent decision.

### Alternatives considered (at the time of the original decision)

- **Widen `PrescribedSetV1` to `targetRepsMin`/`targetRepsMax` now**:
  rejected for this slice — that is a real WDI contract change with its
  own blast radius (every existing WDI consumer, including the mobile
  local schema and the server `performed_sets` mapping code, would need
  review), and nothing in this slice's scope actually needs the range to
  reach Active Workout UI yet, since that UI does not exist. (Superseded:
  the Fix Pass performed exactly this review and found the blast radius
  safe to absorb.)
- **Drop rep-range support from `PlannedSet` to match `PrescribedSetV1`
  exactly**: rejected — the spec explicitly asks for range support, and
  losing it would be a real product regression for hypertrophy
  prescriptions ("8–12 reps" is standard vocabulary), not a neutral
  simplification.

### Consequences (as they stood before the Fix Pass; see resolution above)

Easier: `WorkoutPrescriptionV1` and everything downstream of it (mobile
local schema, sync protocol, server `performed_sets`) needed zero
changes.
Harder: the exact prescribed range was not visible anywhere downstream of
the prescription boundary (only the resolved minimum was) — resolved by
the `RepTargetV1` fix above, which now carries the range losslessly end
to end.
