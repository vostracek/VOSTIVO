import { err, ok, PLANNED_WORKOUT_STATUSES, WORKOUT_SESSION_STATUSES, type Result } from "@vostivo/domain";
import type { MissedWorkoutInputV1 } from "./input.js";
import { TIMELINE_CONSTRAINTS_V1 } from "./vocabulary.js";

export type MissedWorkoutInputValidationErrorV1 =
  | { readonly reason: "INVALID_LOCAL_DATE"; readonly field: string }
  | { readonly reason: "UNSUPPORTED_TIMELINE_CONSTRAINT" }
  | { readonly reason: "DUPLICATE_PLANNED_WORKOUT_ID"; readonly plannedWorkoutId: string }
  | { readonly reason: "INVALID_ORDER"; readonly plannedWorkoutId: string }
  | { readonly reason: "UNSUPPORTED_STATUS"; readonly plannedWorkoutId: string }
  | { readonly reason: "UNSUPPORTED_SESSION_STATUS"; readonly plannedWorkoutId: string };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Strict `YYYY-MM-DD` that names a real calendar day — pure arithmetic, no `Date`, no clock. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= maxDay;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Structural validation only. Structurally VALID but semantically unclear
 * input (e.g. two workouts sharing one authored position) is not an error —
 * it is a REVIEW_REQUIRED decision.
 */
export function validateMissedWorkoutInput(input: MissedWorkoutInputV1): Result<MissedWorkoutInputV1, MissedWorkoutInputValidationErrorV1> {
  if (!isLocalDate(input.athleteLocalDate)) return err({ reason: "INVALID_LOCAL_DATE", field: "athleteLocalDate" });
  if (!(TIMELINE_CONSTRAINTS_V1 as readonly string[]).includes(input.timelineConstraint)) return err({ reason: "UNSUPPORTED_TIMELINE_CONSTRAINT" });
  for (const [index, slot] of input.validTrainingSlots.entries()) {
    if (!isLocalDate(slot)) return err({ reason: "INVALID_LOCAL_DATE", field: `validTrainingSlots[${index}]` });
  }

  const seen = new Set<string>();
  for (const workout of input.plannedWorkouts) {
    if (seen.has(workout.plannedWorkoutId)) return err({ reason: "DUPLICATE_PLANNED_WORKOUT_ID", plannedWorkoutId: workout.plannedWorkoutId });
    seen.add(workout.plannedWorkoutId);
    if (!isNonNegativeInteger(workout.trainingCycleOrder) || !isNonNegativeInteger(workout.workoutOrder)) {
      return err({ reason: "INVALID_ORDER", plannedWorkoutId: workout.plannedWorkoutId });
    }
    if (workout.scheduledLocalDate !== null && !isLocalDate(workout.scheduledLocalDate)) {
      return err({ reason: "INVALID_LOCAL_DATE", field: `plannedWorkouts[${workout.plannedWorkoutId}].scheduledLocalDate` });
    }
    if (!(PLANNED_WORKOUT_STATUSES as readonly string[]).includes(workout.status)) return err({ reason: "UNSUPPORTED_STATUS", plannedWorkoutId: workout.plannedWorkoutId });
    if (workout.canonicalSessionStatus !== null && !(WORKOUT_SESSION_STATUSES as readonly string[]).includes(workout.canonicalSessionStatus)) {
      return err({ reason: "UNSUPPORTED_SESSION_STATUS", plannedWorkoutId: workout.plannedWorkoutId });
    }
  }
  return ok(input);
}
