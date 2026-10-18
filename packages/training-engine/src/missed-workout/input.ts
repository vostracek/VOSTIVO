import type { PlannedWorkoutStatus, WorkoutSessionStatus } from "@vostivo/domain";
import type { TimelineConstraintV1 } from "./vocabulary.js";

/** An ISO-8601 calendar date (`YYYY-MM-DD`) in the athlete's own local calendar — never derived from a clock or UTC midnight inside the engine. */
export type LocalDate = string;

/**
 * One planned workout occurrence, as the caller resolved it. Authored
 * sequence is `(trainingCycleOrder, workoutOrder)` — the existing explicit
 * plan ordering (`TrainingCycle.order`, `PlannedWorkout.order`), never row
 * order, display name or id order.
 */
export interface MissedWorkoutPlannedWorkoutV1 {
  readonly plannedWorkoutId: string;
  readonly programVersionId: string;
  readonly trainingCycleOrder: number;
  readonly workoutOrder: number;
  /** `null` = not scheduled on a date (can never be "missed"). */
  readonly scheduledLocalDate: LocalDate | null;
  /** The existing `PlannedWorkout.status` — SKIPPED/RESCHEDULED/CANCELLED are already resolved and never resurrected. */
  readonly status: PlannedWorkoutStatus;
  /** The occurrence's CANONICAL session (Planned Workout Occurrence Authority V1), or `null` when it has none. */
  readonly canonicalSessionStatus: WorkoutSessionStatus | null;
}

/**
 * The narrowest input the decision needs. Deliberately absent: athlete mode
 * (GUIDED/ADAPTIVE/EXPERT get the same recommendation), Available-Time
 * priority tiers (intra-session, a different responsibility), progression
 * state and any notion of "now" — `athleteLocalDate` is explicit.
 */
export interface MissedWorkoutInputV1 {
  readonly athleteLocalDate: LocalDate;
  /** The ProgramVersion currently applicable to the athlete; `null` = no active plan context. */
  readonly applicableProgramVersionId: string | null;
  readonly timelineConstraint: TimelineConstraintV1;
  readonly plannedWorkouts: readonly MissedWorkoutPlannedWorkoutV1[];
  /**
   * Explicit, caller-supplied training opportunities (local dates). The
   * engine never invents one — not "tomorrow", not "today because the app
   * is open". Dates before `athleteLocalDate` are not future opportunities
   * and are ignored.
   */
  readonly validTrainingSlots: readonly LocalDate[];
}
