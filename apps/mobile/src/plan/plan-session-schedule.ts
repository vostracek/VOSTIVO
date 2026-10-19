import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import { COPY, longDayLabel } from "../missed-workout/missed-workout-flow";
import { workoutDetailHref } from "../progress/progress-routes";

/**
 * Missed Workout V1 Slice D — how Plan/Today present the server's EFFECTIVE
 * schedule (Slice C contract): `scheduledDate` IS the effective date (rows
 * are already placed by the server — the UI never recomputes the overlay).
 * Normal authored rows stay visually clean (no "Authored" label anywhere).
 * An adapted row gets a subtle "Adjusted" tag + "Originally Monday" as
 * secondary context; a carryover (adapted, no effective date) stays visible
 * as "Needs a training day" — never Skipped/Cancelled/Missed, never a date.
 */
export type SessionScheduleNote =
  | { readonly kind: "NONE" }
  | { readonly kind: "ADJUSTED"; readonly tag: string; readonly originally: string | null }
  | { readonly kind: "NEEDS_TRAINING_DAY"; readonly label: string };

export function sessionScheduleNote(session: Pick<PlanSessionSummaryV1, "plannedWorkoutId" | "scheduledDate" | "authoredScheduledDate" | "scheduleSource">): SessionScheduleNote {
  if (session.plannedWorkoutId === null || session.scheduleSource !== "ADAPTED") return { kind: "NONE" };
  if (session.scheduledDate === null) return { kind: "NEEDS_TRAINING_DAY", label: COPY.needsTrainingDay };
  return {
    kind: "ADJUSTED",
    tag: COPY.adjusted,
    originally: session.authoredScheduledDate === null ? null : `Originally ${longDayLabel(session.authoredScheduledDate, session.scheduledDate)}`,
  };
}

/**
 * Progress & Feedback V1 Slice C — the Plan row's restrained session-level
 * progression signal: shown ONLY from the server's `hasAppliedProgression`
 * (derived from the occurrence's own Workout Preview). No mobile inference,
 * no exercise detail — the "62.5kg · Up from 60kg" lives in Workout Preview.
 */
export function sessionProgressionNote(session: Pick<PlanSessionSummaryV1, "hasAppliedProgression">): string | null {
  return session.hasAppliedProgression ? "Progression applied" : null;
}

/**
 * Progress & Feedback V1 Slice D — where a Plan row goes. HISTORICAL REALITY
 * WINS: a COMPLETED occurrence opens the exact canonical session's history
 * (server `completedWorkoutSessionId`, never searched by name/date), not the
 * ordinary Workout Preview. Rest days are not tappable. Every other row keeps
 * its existing Workout Preview behavior (IN_PROGRESS: Preview -> Resume).
 */
export type PlanRowTarget =
  | { readonly kind: "NONE" }
  | { readonly kind: "HISTORY"; readonly href: `/progress/workouts/${string}` }
  | { readonly kind: "PREVIEW"; readonly href: `/workout/${string}` };

export function planRowTarget(session: Pick<PlanSessionSummaryV1, "plannedWorkoutId" | "displayStatus" | "completedWorkoutSessionId">): PlanRowTarget {
  if (session.plannedWorkoutId === null) return { kind: "NONE" };
  if (session.displayStatus === "COMPLETED" && session.completedWorkoutSessionId !== undefined) return { kind: "HISTORY", href: workoutDetailHref(session.completedWorkoutSessionId) };
  // A COMPLETED row without the id (older server) still lands on a preview the server marks `canStart: false` — read-only.
  return { kind: "PREVIEW", href: `/workout/${encodeURIComponent(session.plannedWorkoutId)}` };
}

/** "Upper Body A, completed" — a completed row never sounds startable. */
export function planRowAccessibilityLabel(session: Pick<PlanSessionSummaryV1, "name" | "focus" | "displayStatus">, progressionNote: string | null): string {
  if (session.displayStatus === "COMPLETED") return `${session.name}, completed`;
  return `${session.name}${session.focus !== null ? `, ${session.focus}` : ""}${progressionNote !== null ? `, ${progressionNote}` : ""}`;
}
