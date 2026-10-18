import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import { COPY, longDayLabel } from "../missed-workout/missed-workout-flow";

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
