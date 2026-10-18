import type { MissedWorkoutPreviewResponseV1, MissedWorkoutPreviewReviewReasonV1 } from "@vostivo/contracts";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice D: the athlete-facing
 * flow as PURE state + presentation rules (no React, no I/O) — the same
 * "pure derivation, thin screen" convention as Available-Time's
 * `available-time-flow.ts`. Nothing here re-implements `missed-workout/v1`
 * or the overlay: every workout, date and decision comes from the server
 * preview, and the UI never recomputes the effective schedule.
 *
 * Tone: calm decision support — no guilt, streak or alarm language, and
 * internal reason codes are never shown verbatim.
 */
export type RollForwardPreview = Extract<MissedWorkoutPreviewResponseV1, { result: "ROLL_FORWARD" }>;

export type ApplyActionState = { readonly status: "idle" } | { readonly status: "applying" } | { readonly status: "failed" };

export type MissedWorkoutFlowState =
  /** Nothing to show: not loaded yet, NO_CHANGE, nothing adaptable (no current block), or after a successful apply. */
  | { readonly kind: "IDLE" }
  | {
      readonly kind: "ROLL_FORWARD";
      readonly preview: RollForwardPreview;
      readonly reviewOpen: boolean;
      readonly apply: ApplyActionState;
      /** The previously reviewed recommendation went stale and was replaced — the athlete must review (and Apply) again. */
      readonly planChanged: boolean;
    }
  | { readonly kind: "REVIEW_REQUIRED"; readonly reasonCode: MissedWorkoutPreviewReviewReasonV1 }
  | { readonly kind: "TIMEZONE_REQUIRED"; readonly retrying: boolean }
  /** "Not now": hidden until the next Today refresh. Nothing is persisted. */
  | { readonly kind: "DISMISSED" }
  /** The optional preview failed: degrade quietly (Today stays fully usable). */
  | { readonly kind: "PREVIEW_ERROR" };

export const INITIAL_MISSED_WORKOUT_STATE: MissedWorkoutFlowState = { kind: "IDLE" };

export const COPY = {
  eyebrow: "PLAN UPDATE",
  reviewCta: "Review update",
  reviewTitle: "Keep your plan in sequence",
  unchangedProgram: "Your original program stays unchanged.",
  apply: "Apply update",
  applying: "Updating…",
  retry: "Retry",
  notNow: "Not now",
  applyFailed: "Couldn't update the plan right now.",
  planChanged: "Plan changed. The recommendation was updated. Review it again.",
  needsTrainingDay: "Needs a training day",
  reviewRequiredTitle: "Plan needs review",
  reviewRequiredBody: "Your schedule changed enough that Vostivo won't adjust it automatically.",
  viewPlan: "View plan",
  timeZoneRequired: "Set your training timezone to adjust missed workouts.",
  tryAgain: "Try again",
  adjusted: "Adjusted",
} as const;

export type MissedWorkoutCard =
  | { readonly kind: "RECOMMENDATION"; readonly title: string; readonly body: string }
  | { readonly kind: "REVIEW_REQUIRED"; readonly reason: string | null }
  | { readonly kind: "TIMEZONE_REQUIRED"; readonly retrying: boolean };

/** What Today shows below the Workout Hero — `null` renders nothing (never a placeholder, never a flash). */
export function missedWorkoutCard(state: MissedWorkoutFlowState): MissedWorkoutCard | null {
  switch (state.kind) {
    case "ROLL_FORWARD": {
      const name = state.preview.missedWorkout.displayName;
      return { kind: "RECOMMENDATION", title: `You missed ${name}`, body: `Keep your training sequence intact by doing ${name} next.` };
    }
    case "REVIEW_REQUIRED":
      return { kind: "REVIEW_REQUIRED", reason: reviewRequiredReason(state.reasonCode) };
    case "TIMEZONE_REQUIRED":
      return { kind: "TIMEZONE_REQUIRED", retrying: state.retrying };
    case "IDLE":
    case "DISMISSED":
    case "PREVIEW_ERROR":
      return null;
  }
}

/** A narrow, deterministic human line for the obvious reasons only; anything else shows no reason (never the raw code). */
export function reviewRequiredReason(reasonCode: MissedWorkoutPreviewReviewReasonV1): string | null {
  switch (reasonCode) {
    case "MULTIPLE_MISSED_WORKOUTS":
      return "More than one workout was missed.";
    case "LATER_SESSION_ALREADY_PERFORMED":
      return "A later workout has already been completed.";
    case "NO_KNOWN_TRAINING_SLOT":
      return "There isn't another known training day yet.";
    default:
      return null;
  }
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar date (`YYYY-MM-DD`) as a UTC-midnight instant — pure calendar arithmetic, never the device zone. */
function calendarDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function daysBetween(from: string, to: string): number {
  return Math.round((calendarDay(to).getTime() - calendarDay(from).getTime()) / DAY_MS);
}

/**
 * Short schedule label relative to the athlete's local day (the SERVER's
 * `athleteLocalDate`, never the device date): "Today", a weekday within a
 * week either side ("Fri", "Mon"), otherwise "Mon 19 Oct".
 */
export function shortDayLabel(isoDate: string, athleteLocalDate: string): string {
  if (isoDate === athleteLocalDate) return "Today";
  const day = calendarDay(isoDate);
  const weekday = WEEKDAYS_SHORT[day.getUTCDay()]!;
  return Math.abs(daysBetween(athleteLocalDate, isoDate)) <= 6 ? weekday : `${weekday} ${day.getUTCDate()} ${MONTHS_SHORT[day.getUTCMonth()]!}`;
}

/** "Monday" (or "Monday 28 Sep" when more than a week away) — for the missed workout and "Originally …" context. */
export function longDayLabel(isoDate: string, athleteLocalDate: string | null): string {
  const day = calendarDay(isoDate);
  const weekday = WEEKDAYS_LONG[day.getUTCDay()]!;
  if (athleteLocalDate !== null && Math.abs(daysBetween(athleteLocalDate, isoDate)) > 6) return `${weekday} ${day.getUTCDate()} ${MONTHS_SHORT[day.getUTCMonth()]!}`;
  return weekday;
}

export interface ScheduleMoveRow {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
  /** Where it goes (the proposed effective date). */
  readonly toLabel: string;
  /** Where it currently is (the current effective date), `null` when it currently has none. */
  readonly fromLabel: string | null;
}

export interface NeedsTrainingDayRow {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
}

export interface ScheduleChanges {
  /** CHANGES ONLY: workouts whose proposed date differs from their current effective date. */
  readonly moves: readonly ScheduleMoveRow[];
  /** Carryovers: no proposed date — "Needs a training day". Never an invented date. */
  readonly needsTrainingDay: readonly NeedsTrainingDayRow[];
}

/** The review's changes-only diff, purely from the server preview's sequence items. */
export function scheduleChanges(preview: RollForwardPreview): ScheduleChanges {
  const today = preview.athleteLocalDate;
  const moves: ScheduleMoveRow[] = [];
  const needsTrainingDay: NeedsTrainingDayRow[] = [];
  for (const item of preview.upcomingSequence) {
    if (item.proposedScheduledLocalDate === null) {
      needsTrainingDay.push({ plannedWorkoutId: item.plannedWorkoutId, displayName: item.displayName });
    } else if (item.proposedScheduledLocalDate !== item.effectiveScheduledLocalDate) {
      moves.push({
        plannedWorkoutId: item.plannedWorkoutId,
        displayName: item.displayName,
        toLabel: shortDayLabel(item.proposedScheduledLocalDate, today),
        fromLabel: item.effectiveScheduledLocalDate === null ? null : shortDayLabel(item.effectiveScheduledLocalDate, today),
      });
    }
  }
  return { moves, needsTrainingDay };
}

export interface ReviewSummary {
  readonly missedName: string;
  /** e.g. "Monday"; `null` when the server has no date for it. */
  readonly missedDayLabel: string | null;
  readonly recommendedName: string;
  /** The next known training slot, e.g. "Today". */
  readonly recommendedDayLabel: string;
}

export function reviewSummary(preview: RollForwardPreview): ReviewSummary {
  const today = preview.athleteLocalDate;
  return {
    missedName: preview.missedWorkout.displayName,
    missedDayLabel: preview.missedWorkout.scheduledLocalDate === null ? null : longDayLabel(preview.missedWorkout.scheduledLocalDate, today),
    recommendedName: preview.recommendedNextWorkout.displayName,
    recommendedDayLabel: shortDayLabel(preview.nextTrainingSlot, today),
  };
}
