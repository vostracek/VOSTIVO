import type { PlanSessionDisplayStatus } from "@vostivo/domain";

/**
 * Explicit read projection for the Plan screen (spec section 19) — the
 * mobile client never reconstructs the Program/ProgramVersion/
 * TrainingBlock/TrainingCycle/PlannedWorkout relational graph itself, and
 * this is never a serialized ORM row.
 */
export interface PlanFocusAreaV1 {
  readonly name: string;
  readonly emphasis: "PRIORITY" | "MAINTAIN";
}

export interface PlanCurrentBlockV1 {
  readonly trainingBlockId: string;
  readonly name: string;
  readonly goal: string;
  readonly currentCycleOrder: number;
  readonly cycleCount: number;
  readonly daysPerWeek: number;
}

/**
 * One row in the Plan screen's session list — a planned workout, or a
 * synthesized rest day (`plannedWorkoutId: null`, spec section 29/31: rest
 * days are explicit but visually secondary and have no backing
 * `PlannedWorkout` row to reference).
 */
export interface PlanSessionSummaryV1 {
  readonly plannedWorkoutId: string | null;
  readonly name: string;
  readonly focus: string | null;
  readonly order: number;
  /**
   * The EFFECTIVE date (Missed Workout V1 Slice C: TODAY USES EFFECTIVE
   * SCHEDULE) — equal to the authored date unless an applied roll-forward
   * moved it. `null` = unscheduled; with `scheduleSource: "ADAPTED"` that is
   * a CARRYOVER (still owed, no known training slot — not skipped).
   */
  readonly scheduledDate: string | null;
  /** Additive (Slice C): the authored date, never changed by any adaptation. */
  readonly authoredScheduledDate: string | null;
  /** Additive (Slice C): ADAPTED when an applied roll-forward gives this workout a different effective date than authored. */
  readonly scheduleSource: "AUTHORED" | "ADAPTED";
  readonly estimatedDurationMinutes: number | null;
  readonly displayStatus: PlanSessionDisplayStatus;
  readonly hasActiveSession: boolean;
}

/**
 * Schedule Calendar Authority V1: where the athlete's local date falls in
 * the active plan. Additive and version-compatible (older clients ignore
 * it). Only a configuration defect (ambiguous program/cycle) is an error;
 * BEFORE_PLAN / GAP / AFTER_PLAN are legitimate states.
 */
export type PlanScheduleStateV1 = "NO_PLAN" | "BEFORE_PLAN" | "IN_CURRENT_BLOCK" | "GAP" | "AFTER_PLAN";

export interface PlanScheduleV1 {
  readonly state: PlanScheduleStateV1;
  /**
   * What `currentBlock`/`sessions` show: `CURRENT` = the cycle containing
   * today; `PRESENTATION_FALLBACK` = a nearby cycle shown for context
   * outside a current cycle (BEFORE_PLAN/GAP: the next one; AFTER_PLAN: the
   * last one) — never the domain's current cycle; `null` = nothing shown.
   */
  readonly displayedCycle: "CURRENT" | "PRESENTATION_FALLBACK" | null;
}

/**
 * `currentBlock: null` + empty `sessions`/`weeklyFocus` is the safe empty
 * state (spec section 37, PLAN-API-005) for "no active Program" — never a
 * 404/error for a legitimate, expected state.
 */
export interface PlanOverviewV1 {
  readonly currentBlock: PlanCurrentBlockV1 | null;
  readonly sessions: readonly PlanSessionSummaryV1[];
  readonly weeklyFocus: readonly PlanFocusAreaV1[];
  readonly schedule: PlanScheduleV1;
}
