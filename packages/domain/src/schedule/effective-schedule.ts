import type { AthleteLocalDate } from "./training-time-zone.js";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice C: the ONE effective
 * schedule resolver (docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md §10).
 *
 *   AUTHORED PLAN + the block's ACTIVE missed-workout application
 *   -> EFFECTIVE SCHEDULE
 *
 * AUTHORED SCHEDULE IS IMMUTABLE and always kept alongside: every resolved
 * occurrence carries both `authoredScheduledLocalDate` and
 * `effectiveScheduledLocalDate`. Without an active application they are
 * equal. With one, its (complete) assignment snapshot wins for exactly the
 * workouts it covers. A covered workout whose effective date is `null` is
 * a CARRYOVER: still owed, in sequence, but with no known training slot
 * yet — UNKNOWN AVAILABILITY REMAINS UNSCHEDULED, and a carryover is not
 * skipped. Pure; row order never matters.
 */
export type ScheduleSource = "AUTHORED" | "ADAPTED";

export interface EffectiveScheduleAssignment {
  readonly plannedWorkoutId: string;
  readonly effectiveScheduledLocalDate: AthleteLocalDate | null;
}

export interface EffectiveScheduleFields {
  readonly authoredScheduledLocalDate: AthleteLocalDate | null;
  readonly effectiveScheduledLocalDate: AthleteLocalDate | null;
  /** ADAPTED = the active application gives this workout a different effective date than authored (incl. carryover). */
  readonly scheduleSource: ScheduleSource;
  /** Covered by the active application with no known effective slot. */
  readonly isCarryover: boolean;
}

export function resolveEffectiveSchedule<T extends { readonly plannedWorkoutId: string; readonly authoredScheduledLocalDate: AthleteLocalDate | null }>(
  occurrences: readonly T[],
  activeAssignments: readonly EffectiveScheduleAssignment[] | null,
): (T & EffectiveScheduleFields)[] {
  const byWorkout = new Map((activeAssignments ?? []).map((a) => [a.plannedWorkoutId, a.effectiveScheduledLocalDate]));
  return occurrences.map((occurrence) => {
    if (!byWorkout.has(occurrence.plannedWorkoutId)) {
      return { ...occurrence, effectiveScheduledLocalDate: occurrence.authoredScheduledLocalDate, scheduleSource: "AUTHORED", isCarryover: false };
    }
    const effective = byWorkout.get(occurrence.plannedWorkoutId) ?? null;
    return {
      ...occurrence,
      effectiveScheduledLocalDate: effective,
      scheduleSource: effective === occurrence.authoredScheduledLocalDate ? "AUTHORED" : "ADAPTED",
      isCarryover: effective === null,
    };
  });
}

/**
 * ROLL_FORWARD slot assignment: the i-th workout of the decision sequence
 * takes the i-th known training slot; the rest are carryover (`null`).
 * Never invents a slot, extrapolates cadence or converts a rest day.
 */
export function assignRollForwardSlots(sequence: readonly string[], knownTrainingSlots: readonly AthleteLocalDate[]): EffectiveScheduleAssignment[] {
  const slots = [...new Set(knownTrainingSlots)].sort();
  return sequence.map((plannedWorkoutId, index) => ({ plannedWorkoutId, effectiveScheduledLocalDate: slots[index] ?? null }));
}
