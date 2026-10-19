import type { PlannedWorkout } from "./planned-workout.js";
import type { WorkoutSessionStatus } from "../workout/workout-session.js";

/**
 * A read-only, UI-facing derived state (spec section 20/29) — never
 * written back onto `PlannedWorkout` (spec section 8). `REST` has no
 * backing `PlannedWorkout` row at all; it is synthesized by the read
 * model for a scheduled day with nothing planned (see
 * docs/architecture/PLAN-PRESCRIPTION.md).
 *
 * `matchingSession` is the occurrence's CANONICAL session (Planned Workout
 * Occurrence Authority claim) — a SECONDARY session never drives this
 * status. A FINISHed canonical session (full or partial) is `COMPLETED`:
 * HISTORICAL REALITY WINS over the planned date (Progress & Feedback V1
 * Slice D — the row then opens history, never an ordinary Start).
 */
export const PLAN_SESSION_DISPLAY_STATUSES = [
  "COMPLETED",
  "IN_PROGRESS",
  "TODAY",
  "PLANNED",
  "SKIPPED",
  "RESCHEDULED",
  "CANCELLED",
  "REST",
] as const;
export type PlanSessionDisplayStatus = (typeof PLAN_SESSION_DISPLAY_STATUSES)[number];

export interface MatchingWorkoutSessionInfo {
  readonly status: WorkoutSessionStatus;
}

/**
 * Combines `PlannedWorkout` intent with `WorkoutSession` reality (spec
 * section 20) — reality always wins when a matching session exists;
 * `plannedWorkout.status` only matters when there is none.
 * `todayIsoDate` is passed in (not read from the system clock here) so
 * this stays a pure, deterministically testable function.
 */
export function deriveSessionDisplayStatus(
  plannedWorkout: PlannedWorkout,
  matchingSession: MatchingWorkoutSessionInfo | undefined,
  todayIsoDate: string,
): PlanSessionDisplayStatus {
  if (matchingSession?.status === "COMPLETED") return "COMPLETED";
  if (matchingSession?.status === "ACTIVE") return "IN_PROGRESS";

  if (plannedWorkout.status === "SKIPPED") return "SKIPPED";
  if (plannedWorkout.status === "RESCHEDULED") return "RESCHEDULED";
  if (plannedWorkout.status === "CANCELLED") return "CANCELLED";

  if (plannedWorkout.scheduledDate === todayIsoDate) return "TODAY";
  return "PLANNED";
}
