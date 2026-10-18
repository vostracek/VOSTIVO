import type { EntityId } from "../entity-id.js";
import type { PlannedWorkoutId } from "./planned-workout.js";

export type PlannedExerciseId = EntityId<"PlannedExercise">;

/**
 * `exerciseRef` is the same intentionally-opaque, unresolved catalog
 * pointer boundary already used by
 * `WorkoutPrescriptionV1.PrescribedExerciseV1.exerciseRef` (spec section
 * 10/12) — this slice does not solve Exercise Taxonomy. `displayName` is
 * always required so this planned exercise reads correctly even before
 * any catalog exists at all. `role` (spec section 10's "role / target
 * context") is deliberately NOT included: no exercise-role vocabulary
 * (e.g. primary/accessory) is specified anywhere in the approved domain
 * model yet, and inventing one would be exactly the kind of silent
 * decision this task asks to avoid — see
 * docs/architecture/PLAN-PRESCRIPTION.md, "Deliberate deferrals."
 */
export interface PlannedExercise {
  readonly id: PlannedExerciseId;
  readonly plannedWorkoutId: PlannedWorkoutId;
  readonly exerciseRef: string | null;
  readonly displayName: string;
  readonly order: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
