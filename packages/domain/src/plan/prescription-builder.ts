import type { WorkoutPrescriptionV1 } from "../workout/prescription.js";
import type { PlannedWorkout } from "./planned-workout.js";
import type { PlannedExercise } from "./planned-exercise.js";
import type { PlannedSet } from "./planned-set.js";

export interface PlannedExerciseWithSets {
  readonly exercise: PlannedExercise;
  readonly sets: readonly PlannedSet[];
}

export interface PlannedWorkoutDetail {
  readonly workout: PlannedWorkout;
  readonly exercises: readonly PlannedExerciseWithSets[];
}

/**
 * The Plan -> Workout Data Integrity integration point (spec section 23).
 * Pure and deterministic: the same `PlannedWorkoutDetail` always produces
 * the same `WorkoutPrescriptionV1` — every id in the result is the
 * corresponding planned entity's own stable id (`prescriptionId` =
 * `plannedWorkoutId`, etc.), never freshly minted, so calling this twice
 * for the same planned workout yields identical prescription ids
 * (PLAN-004) and a mutation to the *source* planned rows after a
 * `WorkoutSession` has already snapshotted a prior call's result cannot
 * retroactively change that snapshot (PLAN-005) — this function has no
 * side effect and does not touch the session.
 *
 * `targetReps` is carried through losslessly (Plan Contract Integrity Fix
 * Pass, section 1/2) — a `RANGE` stays a `RANGE`, never collapsed to its
 * minimum. See ADR-0008's "Decision 2" for the history of this boundary.
 */
export function createWorkoutPrescriptionFromPlannedWorkout(
  detail: PlannedWorkoutDetail,
): WorkoutPrescriptionV1 {
  return {
    schemaVersion: 1,
    prescriptionId: detail.workout.id,
    name: detail.workout.name,
    exercises: [...detail.exercises]
      .sort((a, b) => a.exercise.order - b.exercise.order)
      .map((entry) => ({
        prescriptionExerciseId: entry.exercise.id,
        exerciseRef: entry.exercise.exerciseRef,
        displayName: entry.exercise.displayName,
        order: entry.exercise.order,
        sets: [...entry.sets]
          .sort((a, b) => a.order - b.order)
          .map((set) => ({
            prescriptionSetId: set.id,
            order: set.order,
            targetReps: set.targetReps,
            targetLoad: set.targetLoad,
            restSeconds: set.restSeconds,
            setType: set.setType,
          })),
      })),
  };
}
