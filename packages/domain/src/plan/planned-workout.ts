import type { EntityId } from "../entity-id.js";
import type { TrainingCycleId } from "./training-cycle.js";

export type PlannedWorkoutId = EntityId<"PlannedWorkout">;

/**
 * Scheduling/planning status ONLY (spec section 8, a previously locked
 * correction). `PlannedWorkout` must never persist `STARTED`/`COMPLETED`
 * — that is execution truth and belongs exclusively to `WorkoutSession`
 * (Workout Data Integrity). A read model derives a display state like
 * "Completed" by joining a `PlannedWorkout` against matching
 * `WorkoutSession` reality (see docs/architecture/PLAN-PRESCRIPTION.md,
 * "Session status projection") — it never writes that derived state back
 * onto this row.
 */
export const PLANNED_WORKOUT_STATUSES = [
  "PLANNED",
  "AVAILABLE",
  "SKIPPED",
  "RESCHEDULED",
  "CANCELLED",
] as const;
export type PlannedWorkoutStatus = (typeof PLANNED_WORKOUT_STATUSES)[number];

/**
 * `scheduledDate` is optional — a cycle's workouts are ordered (spec
 * section 9's "order / scheduled position") independent of whether every
 * V1 fixture also assigns a concrete date. `estimatedDurationMinutes` is a
 * plain author-entered number (no calculation from sets/rest yet).
 */
export interface PlannedWorkout {
  readonly id: PlannedWorkoutId;
  readonly trainingCycleId: TrainingCycleId;
  readonly name: string;
  readonly focus: string | null;
  readonly order: number;
  readonly scheduledDate: string | null;
  readonly estimatedDurationMinutes: number | null;
  readonly status: PlannedWorkoutStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
