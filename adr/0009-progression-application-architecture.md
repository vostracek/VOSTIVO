# ADR-0009: Progression Application V1 — effective-value overlay over immutable ProgramVersion structure

- **Status**: Accepted
- **Date**: 2026-09-23

**Acceptance note (2026-09-23):** the overlay architecture, exercise-level
progression-stream identity, `effectiveFrom` program-order semantics, the
one-current-overlay invariant, the immutable-`ProgramVersion` boundary, the
application state model, and the resolver architecture have all passed
tech-lead review. The remaining `LoadingCapability` mechanism (see
`docs/domain/LOADING-CAPABILITY-V1.md`) is a prerequisite for *numeric*
`INCREASE_LOAD` auto-resolution, not an open question about whether this
ADR's own architecture is correct — it does not block acceptance of this
decision.

## Context

Progression Evaluation Orchestration V1 persists an immutable
`progression_decisions` row (`INCREASE_LOAD` / `MAINTAIN_LOAD_BUILD_REPS` /
`NO_CHANGE`) for every completed workout, with `appliedAt` always `null` —
recommendation, never a change to future training. Progression Application
V1 must define what happens when a recommendation is actually accepted:
specifically, how a future `PlannedSet.targetLoad` (currently a
directly-authored column, read fresh on every Plan/Preview request — see
`docs/domain/PROGRESSION-APPLICATION-V1.md` §1) can reflect an applied
progression, without violating `ProgramVersion`'s existing, locked,
effectively-immutable structural-versioning invariant (ADR-0008: a
structural change to `TrainingBlock`/`TrainingCycle`/`PlannedWorkout`
creates a new `ProgramVersion` rather than mutating the active one).

Repository inspection (full detail in the specification document) found:
no code anywhere ever creates a second `ProgramVersion` or updates any
`plan.ts`-schema row after initial insert; no stable identity exists for
"the same programmed exercise slot repeated across future weeks"; future
cycles are not reliably materialized in advance today. Progression
Application V1 would be the first write path ever built against Plan
state.

## Decision

Introduce a new, additive table, `app.progression_applications`, that
records an **effective-value overlay** for a derived, **exercise-level**
**Program Slot Identity**: `programVersionId + trainingBlockId +
workoutOrderIndex + exerciseOrderIndex` — deliberately **excluding**
`setOrderIndex` (the Progression Engine's own evaluation, and the
`reconstructPrescriptionContext()` precondition it already depends on, are
exercise-level, not set-level: a decision is never evidence for "this one
set" independent of its sibling `WORKING` sets) and excluding
`TrainingCycle` (a progression stream is, by definition, the *same*
programmed slot repeated *across* cycles — including the cycle in the
identity would make every week's occurrence a different stream, the
opposite of what is needed). Computed entirely from existing `orderIndex`
columns already unique at each level of the hierarchy; no new identity
column is added anywhere. A separate field, `effectiveFromCycleOrderIndex`
(the *source* occurrence's own cycle order — program order, never a
timestamp), bounds which future occurrences are eligible, so that an
overlay never retroactively affects the source occurrence or any past one.

The originally-authored `PlannedSet.targetLoad`/`targetReps` values are
**never overwritten**. A single, pure resolution function
(`resolveEffectivePlannedSetTarget`) merges "authored value" with "the
one current (non-superseded) `APPLIED` overlay for this stream" into the
*effective* value — explicitly returning the authored value unchanged for
any `WARM_UP` set, regardless of an active overlay, since the overlay is
an exercise-level `WORKING`-set concept only. `PlanReadService`'s
Plan-overview and Workout-Preview reads, and the `WorkoutSession`
prescription-snapshot boundary, all resolve through this one function —
never through independent merge logic. A partial unique index enforces
"at most one current `APPLIED` overlay per stream" (`WHERE status =
'APPLIED' AND superseded_by_application_id IS NULL`), mirroring
`program_versions_one_active_per_program` (ADR-0008) exactly — a later
application becoming current explicitly supersedes the previous one; an
already-`APPLIED` overlay is never silently reverted by a merely newer,
un-applied recommendation (e.g. a subsequent `NO_CHANGE` decision leaves
an already-applied increase untouched).

`ProgramVersion`/`TrainingBlock`/`TrainingCycle`/`PlannedWorkout`/
`PlannedExercise`/`PlannedSet` remain completely untouched by this feature:
no row in any of those tables is ever inserted, updated, or deleted by
Progression Application V1.

## Alternatives considered

- **A new `ProgramVersion` per applied routine progression** (clone the
  full structural subtree, bump `versionNumber`, activate, supersede).
  Rejected: no clone mechanism exists today and would need to be built
  from nothing; a realistic program would gain a new "version" for every
  single +2.5 kg bump on one set, diluting `ProgramVersion`'s own meaning
  as a *structural* version (ADR-0008) and directly contradicting the
  locked product principle "use the smallest necessary change." Rollback
  of one unwanted change would also revert every other change bundled
  into that version.
- **Materialize a new prescription layer only at workout-start time**
  (defer resolution until `startWorkoutSession()`). Rejected: the Plan and
  Workout Preview surfaces must show the *same* resolved value *before*
  the athlete starts a workout (no situation where Plan says 100 kg and
  Preview says 102.5 kg) — deferring resolution to start-time alone would
  leave every pre-start read stale. Resolving on every read is cheap at
  this traffic volume, so this option collapses into the chosen approach
  applied consistently, rather than being a genuinely distinct one.

## Consequences

Easier: `ProgramVersion`'s structural-versioning meaning stays exactly as
ADR-0008 defined it, with zero special-casing for progression; rollback of
one applied progression is a single-row status change, not version
surgery; the pattern generalizes directly to a future Fatigue/Adaptation
Engine's own "change what a future workout resolves to" needs, without
requiring a second overlay mechanism to be invented later; the identity
scheme requires no new column anywhere, only a derived join.

Harder: every Plan/Preview/Snapshot read path must be updated to resolve
through the new merge function rather than reading `PlannedSet` columns
directly — a real, must-not-be-skipped integration point (specification
§22/§23), and a future implementer who adds a fourth read path must
remember to route it through the same function or reintroduce the
inconsistency this ADR exists to prevent. The scheme also depends on
Program Slot Identity correspondence holding within one `TrainingBlock`
(the same `orderIndex` tuple repeating per cycle) — a convention, not a
DB-enforced guarantee; a future block whose cycles genuinely vary in
structure simply yields fewer matching future slots, never an incorrect
match (documented as an explicit, safe failure mode in the specification,
§2/§28), so this is an accepted, non-silent limitation rather than a
correctness risk. If a future program-generation feature cannot honor
this convention, that is the trigger to introduce a first-class, persisted
Program Slot ID — not a license to fall back to fuzzy matching.

This decision does **not** by itself unblock numeric `INCREASE_LOAD`
auto-application: no persisted `LoadingCapability`/`GymProfile` source
exists anywhere in the repository today (`docs/domain/load-model-v1.md`'s
own `GymEquipment configuration` concept, named but never implemented).
The overlay/state-machine architecture this ADR decides is fully buildable
independent of that gap, but every `INCREASE_LOAD` application will
resolve to `LOAD_CAPABILITY_UNAVAILABLE` (a safe, honest, non-guessing
terminal outcome) until it is separately addressed — tracked as an open
tech-lead follow-up in the specification document, not resolved by this
ADR.
