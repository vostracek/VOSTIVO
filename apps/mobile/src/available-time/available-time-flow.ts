import type { AvailableTimePreviewResponseV1, PlanSessionSummaryV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { ActiveWorkoutSession } from "../workout/active-workout-session";

/**
 * Available-Time Adaptation V1 — Slice D: the athlete-facing flow as PURE
 * state + presentation rules (no React, no I/O) — the same "pure,
 * unit-tested derivation, thin screen" convention as
 * `deriveTodayHeroState`. Nothing here re-implements `available-time/v1`:
 * every structural fact comes from the server preview.
 */

export const QUICK_TIME_CHOICES_MINUTES = [30, 45, 60, 75] as const;
export const MIN_AVAILABLE_MINUTES = 1;
export const MAX_AVAILABLE_MINUTES = 240;

/** Explicit athlete context: nothing is selected until the athlete chooses (no default). */
export type TimeSelection = { readonly kind: "none" } | { readonly kind: "preset"; readonly minutes: number } | { readonly kind: "custom"; readonly text: string };

export type AvailableTimeFlowState =
  | { readonly kind: "SELECT_TIME"; readonly selection: TimeSelection }
  | { readonly kind: "LOADING_PREVIEW"; readonly availableMinutes: number; readonly selection: TimeSelection }
  | {
      readonly kind: "ADJUST_SESSION";
      readonly availableMinutes: number;
      readonly selection: TimeSelection;
      readonly preview: AvailableTimePreviewResponseV1;
      /** The canonical normal Workout Preview fetched WITH the time preview, so starting needs no network. */
      readonly workoutPreview: WorkoutPreviewV1;
      readonly start: StartActionState;
    }
  | {
      readonly kind: "NO_CHANGE";
      readonly availableMinutes: number;
      readonly selection: TimeSelection;
      readonly preview: AvailableTimePreviewResponseV1;
      readonly workoutPreview: WorkoutPreviewV1;
      readonly start: StartActionState;
    }
  | { readonly kind: "CANNOT_FIT_MINIMUM"; readonly availableMinutes: number; readonly selection: TimeSelection; readonly preview: AvailableTimePreviewResponseV1 }
  | { readonly kind: "PREVIEW_ERROR"; readonly availableMinutes: number; readonly selection: TimeSelection };

export type StartActionState = { readonly status: "idle" } | { readonly status: "starting" } | { readonly status: "failed"; readonly message: string };

export const INITIAL_FLOW_STATE: AvailableTimeFlowState = { kind: "SELECT_TIME", selection: { kind: "none" } };

export type CustomMinutesValidation =
  | { readonly status: "empty" }
  | { readonly status: "valid"; readonly minutes: number }
  | { readonly status: "invalid"; readonly message: string };

const WHOLE_MINUTES_ERROR = `Enter whole minutes from ${MIN_AVAILABLE_MINUTES} to ${MAX_AVAILABLE_MINUTES}.`;

/** Strict: digits only (no decimals, signs, spaces) and 1–240. Never clamped, never rounded. */
export function validateCustomMinutes(text: string): CustomMinutesValidation {
  if (text.length === 0) return { status: "empty" };
  if (!/^\d+$/.test(text)) return { status: "invalid", message: WHOLE_MINUTES_ERROR };
  const minutes = Number(text);
  if (minutes < MIN_AVAILABLE_MINUTES || minutes > MAX_AVAILABLE_MINUTES) return { status: "invalid", message: WHOLE_MINUTES_ERROR };
  return { status: "valid", minutes };
}

/** The minutes "Preview changes" would submit — `null` keeps the CTA disabled. */
export function submittableMinutes(selection: TimeSelection): number | null {
  if (selection.kind === "preset") return selection.minutes;
  if (selection.kind === "custom") {
    const validation = validateCustomMinutes(selection.text);
    return validation.status === "valid" ? validation.minutes : null;
  }
  return null;
}

/** One shared rounding rule: partial minutes round UP, so the UI never understates a duration. */
export function estimatedMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

export type ChangeRow =
  | { readonly kind: "REDUCED"; readonly plannedExerciseId: string; readonly displayName: string; readonly fromSets: number; readonly toSets: number }
  | { readonly kind: "REMOVED"; readonly plannedExerciseId: string; readonly displayName: string };

/**
 * V1 shows only what changes (unchanged exercises are hidden): a removed
 * exercise, or a retained exercise that lost sets. Built purely from the
 * server's own per-exercise result — never re-derived.
 */
export function changeRows(preview: AvailableTimePreviewResponseV1): ChangeRow[] {
  return preview.exercises.flatMap((exercise): ChangeRow[] => {
    if (exercise.removedEntireExercise) return [{ kind: "REMOVED", plannedExerciseId: exercise.plannedExerciseId, displayName: exercise.displayName }];
    if (exercise.removedWorkingSetCount > 0) {
      return [{ kind: "REDUCED", plannedExerciseId: exercise.plannedExerciseId, displayName: exercise.displayName, fromSets: exercise.originalWorkingSetCount, toSets: exercise.retainedWorkingSetCount }];
    }
    if (exercise.retainedTotalSetCount < exercise.originalTotalSetCount) {
      return [{ kind: "REDUCED", plannedExerciseId: exercise.plannedExerciseId, displayName: exercise.displayName, fromSets: exercise.originalTotalSetCount, toSets: exercise.retainedTotalSetCount }];
    }
    return [];
  });
}

export function changeRowDetail(row: ChangeRow): string {
  return row.kind === "REMOVED" ? "Removed today" : `${row.fromSets} → ${row.toSets} sets`;
}

/**
 * Today offers "Adjust time" only for an eligible planned workout of TODAY
 * that nobody has started: Resume always wins (the hero is then `resume`),
 * and a session the server already reports as started is not adjustable.
 */
export function adjustableTodaySession(hero: { readonly kind: string; readonly session?: PlanSessionSummaryV1 }): (PlanSessionSummaryV1 & { readonly plannedWorkoutId: string }) | null {
  if (hero.kind !== "training-day" || hero.session === undefined) return null;
  const { session } = hero;
  if (session.plannedWorkoutId === null || session.hasActiveSession || session.displayStatus !== "TODAY") return null;
  return { ...session, plannedWorkoutId: session.plannedWorkoutId };
}

/** Active Workout's restrained sublabel — from durable LOCAL metadata only; `null` for every ordinary session (render nothing). */
export function adjustedSessionLabel(session: Pick<ActiveWorkoutSession, "availableTimeApplication">): string | null {
  return session.availableTimeApplication === null ? null : `Adjusted · ${session.availableTimeApplication.availableMinutes} min`;
}
