import { shortDayLabel } from "../missed-workout/missed-workout-flow";
import { workoutDetailHref } from "../progress/progress-routes";
import type { CompletedTodayWorkout, NextPlannedWorkout } from "./today-derivation";

/**
 * Progress & Feedback V1 Slice D — Today's calm "Workout complete" hero.
 * ONE SCREEN, ONE PRIMARY JOB: nothing left to start today, so the only
 * action is the secondary "View workout" (the exact canonical session's
 * history). No celebration, streak, score or Start/Resume/Adjust copy.
 */
export interface CompletedTodayView {
  readonly microLabel: string;
  readonly title: string;
  readonly body: string;
  readonly viewWorkoutLabel: string;
  readonly viewWorkoutHref: `/progress/workouts/${string}`;
  /** "Lower Body A · Thu" — omitted when the server plan has no trustworthy next session. */
  readonly next: string | null;
  readonly accessibilityLabel: string;
}

export const COMPLETED_TODAY_COPY = {
  microLabel: "Workout complete",
  body: "Today's training is saved.",
  viewWorkout: "View workout",
  nextLabel: "Next",
} as const;

export function completedTodayView(completed: CompletedTodayWorkout, nextWorkout: NextPlannedWorkout | null): CompletedTodayView {
  const next = nextWorkout === null ? null : `${nextWorkout.session.name} · ${shortDayLabel(nextWorkout.scheduledDate, nextWorkout.athleteLocalDate)}`;
  return {
    microLabel: COMPLETED_TODAY_COPY.microLabel,
    title: completed.name,
    body: COMPLETED_TODAY_COPY.body,
    viewWorkoutLabel: COMPLETED_TODAY_COPY.viewWorkout,
    viewWorkoutHref: workoutDetailHref(completed.workoutSessionId),
    next,
    accessibilityLabel: `Workout complete: ${completed.name}. ${COMPLETED_TODAY_COPY.body}${next === null ? "" : ` Next: ${next}.`}`,
  };
}
