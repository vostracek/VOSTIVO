import type { EntityId } from "../entity-id.js";
import type { ExternalWeightLoad } from "../load/load.js";
import type { RepTargetV1 } from "../rep-target.js";
import type { SetType } from "../workout/set-type.js";
import type { PlannedExerciseId } from "./planned-exercise.js";

export type PlannedSetId = EntityId<"PlannedSet">;

/**
 * Target is Intent, never Reality (spec section 11) — nothing here is
 * ever overwritten by what actually happened; that stays exclusively on
 * `PerformedSet`.
 *
 * `targetReps` is a `RepTargetV1` — exact or a range (e.g. "8-12") — and
 * is the single authoritative source of rep-target semantics (Plan
 * Contract Integrity Fix Pass, section 2). It flows through to
 * `PrescribedSetV1.targetReps` (Workout Data Integrity's immutable
 * `WorkoutPrescriptionV1` snapshot) losslessly — see
 * `prescription-builder.ts` and ADR-0008's "Decision 2" (updated by the
 * fix pass; the range is no longer collapsed to its minimum).
 *
 * Physical storage remains the pre-existing two nullable integer columns
 * (`target_reps_min`/`target_reps_max` in
 * `packages/database/src/schema/plan.ts`) — no migration was needed;
 * `repTargetFromRange`/`repTargetToRange` (`rep-target.ts`) are the only
 * place that reinterpretation happens.
 *
 * Planned RIR target is explicitly deferred (spec section 13) — no field
 * exists here for it. No numeric RIR range/policy is specified anywhere
 * in the approved Training Engine spec (`packages/training-engine`) to
 * implement against, and `PerformedSet` already established the
 * precedent of omitting RIR entirely rather than inventing that policy
 * (docs/architecture/WORKOUT-DATA-INTEGRITY.md).
 */
export interface PlannedSet {
  readonly id: PlannedSetId;
  readonly plannedExerciseId: PlannedExerciseId;
  readonly order: number;
  readonly targetReps: RepTargetV1 | null;
  readonly targetLoad: ExternalWeightLoad | null;
  /**
   * Prescribed rest duration after this set (Active Workout Core Logger
   * V1, section 20) — optional because not every historical/hand-entered
   * prescription specifies one. `null` means "not specified," not "no
   * rest": a UI that needs a concrete duration falls back to a single
   * centralized default (`apps/mobile/src/workout/rest-timer.ts`'s
   * `DEFAULT_REST_SECONDS`), never an invisible magic number scattered
   * elsewhere. Not a Training Engine rest-optimization decision — a plain
   * authored value, same status as `estimatedDurationMinutes` elsewhere in
   * this hierarchy.
   */
  readonly restSeconds: number | null;
  /**
   * Required, never null (Progression Prerequisites V1, docs/domain/
   * PROGRESSION-ENGINE-V1.md §5.2, tech-lead-resolved OD-3) — a plan
   * author who doesn't think about set type gets `WORKING` written
   * explicitly at write time by the calling code; this column is never a
   * nullable "null means WORKING" default resolved later. Carried
   * through losslessly to `PrescribedSetV1.setType` — see
   * `prescription-builder.ts`.
   */
  readonly setType: SetType;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
