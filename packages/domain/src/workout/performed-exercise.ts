import type { EntityId } from "../entity-id.js";
import type { ExerciseIdentityV1 } from "../exercise-identity.js";
import type { WorkoutSessionId } from "./workout-session.js";

export type PerformedExerciseId = EntityId<"PerformedExercise">;

/**
 * Represents reality, not intent. `prescriptionExerciseId` is null for an
 * unplanned exercise the athlete performed anyway — the architecture must
 * not prevent that (spec section 10). `displayName` is a snapshot, same
 * reasoning as `PrescribedExerciseV1.displayName`.
 *
 * `exerciseRef` is a snapshot of `PrescribedExerciseV1.exerciseRef` at
 * completion time (Active Workout Core Logger V1, section 8) — this is
 * what makes "Previous performance" possible: `prescriptionExerciseId`
 * identifies one specific `PlannedWorkout`'s instance and is not stable
 * across separate training cycles/weeks, but `exerciseRef` is the
 * intentionally stable catalog pointer.
 *
 * Required, never null (Exercise Ref Legacy Reconciliation,
 * docs/domain/PROGRESSION-ENGINE-V1.md §29 correction) — canonical server
 * workout reality must not carry a permanent "unknown exercise" steady
 * state. This is narrower than `PrescribedExerciseV1.exerciseRef` /
 * `PlannedExercise.exerciseRef`, which remain nullable on the Plan side
 * (out of scope here): a `COMPLETE_SET_V1` command sourced from a
 * planned exercise without a resolved ref is rejected rather than
 * persisted with a null identity.
 */
export interface PerformedExercise {
  readonly id: PerformedExerciseId;
  readonly workoutSessionId: WorkoutSessionId;
  readonly prescriptionExerciseId: string | null;
  readonly exerciseRef: ExerciseIdentityV1;
  readonly displayName: string;
  readonly order: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
