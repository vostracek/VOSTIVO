import type { WorkoutPreviewExerciseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { ExternalWeightLoad } from "@vostivo/domain";
import { formatLoad, formatRepTarget } from "./format-target";
import { workoutDetailHref } from "../progress/progress-routes";

/**
 * Progress & Feedback V1 — Slice C: Workout Preview copy. RULES DECIDE; UI
 * EXPLAINS: "up from" appears ONLY when the server returned
 * `exercise.progression` for this exercise — never inferred from history, a
 * load difference or local state. The shown target is the WORKING load of
 * the exact prescription START will snapshot (`preview.prescription`), so
 * Preview and Active Workout can never disagree.
 */
export interface PreviewProgressionView {
  /** The effective WORKING target, e.g. "62.5kg" — primary. */
  readonly target: string;
  /** Supporting context, e.g. "Up from 60kg". */
  readonly upFrom: string;
}

export interface PreviewExerciseView {
  readonly key: string;
  readonly title: string;
  readonly setLines: readonly string[];
  readonly progression: PreviewProgressionView | null;
  readonly accessibilityLabel: string;
}

export function previewExerciseView(exercise: WorkoutPreviewExerciseV1, preview: Pick<WorkoutPreviewV1, "prescription">): PreviewExerciseView {
  const setLines = exercise.sets.map((set) => `${formatRepTarget(set.targetReps)}${set.targetLoad !== null ? ` · ${formatLoad(set.targetLoad)}` : ""}`);
  const target = progressionTarget(exercise, preview);
  const progression = target === null || exercise.progression === undefined ? null : { target: formatLoad(target), upFrom: `Up from ${formatLoad(exercise.progression.previousLoad)}` };
  const spokenProgression = target === null || exercise.progression === undefined ? "" : ` Target ${spokenLoad(target)}, up from ${spokenLoad(exercise.progression.previousLoad)}.`;
  return {
    key: exercise.plannedExerciseId,
    title: exercise.displayName,
    setLines,
    progression,
    accessibilityLabel: `${exercise.displayName}, ${exercise.sets.length} ${exercise.sets.length === 1 ? "set" : "sets"}: ${setLines.join("; ")}.${spokenProgression}`,
  };
}

/**
 * The uniform WORKING target in the START prescription for this exercise —
 * only when the server marked it as progressed and it is not a substitute
 * (a substitute never carries authored progression). Anything not uniform
 * fails closed: no "up from" rather than a guess.
 */
function progressionTarget(exercise: WorkoutPreviewExerciseV1, preview: Pick<WorkoutPreviewV1, "prescription">): ExternalWeightLoad | null {
  if (exercise.progression === undefined || exercise.substitution !== undefined) return null;
  const prescribed = preview.prescription.exercises.find((e) => e.prescriptionExerciseId === exercise.plannedExerciseId);
  const working = prescribed?.sets.filter((set) => set.setType === "WORKING").map((set) => set.targetLoad) ?? [];
  const [first] = working;
  if (first === undefined || first === null) return null;
  const uniform = working.every((load) => load !== null && load.amountMilli === first.amountMilli && load.unit === first.unit && load.basis === first.basis);
  return uniform ? first : null;
}

/** "62.5 kilograms", "135 pounds each" — for screen readers. */
export function spokenLoad(load: ExternalWeightLoad): string {
  return `${load.amountMilli / 1000} ${load.unit === "KG" ? "kilograms" : "pounds"}${load.basis === "PER_IMPLEMENT" ? " each" : ""}`;
}

/**
 * Progress & Feedback V1 Slice D — the Workout Preview footer. HISTORICAL
 * REALITY WINS: an occurrence whose canonical session is COMPLETED is read
 * only on every path (Plan, Today, old/deep links) — "Workout completed" +
 * optional "View workout" (exact canonical id from the server), never Start,
 * Adjust time, Equipment or a repeat shortcut. Opened from Progress
 * (`previewOnly`) it stays the Slice C "Preview only" footer. Everything
 * else is unchanged (IN_PROGRESS: Start resolves to the active session).
 */
export type PreviewFooter =
  | { readonly kind: "START" }
  | { readonly kind: "PREVIEW_ONLY"; readonly text: string }
  | { readonly kind: "COMPLETED"; readonly text: string; readonly viewWorkoutHref: `/progress/workouts/${string}` | null };

export const PREVIEW_FOOTER_COPY = {
  previewOnly: "Preview only · start this workout from Today or Plan",
  completed: "Workout completed",
  viewWorkout: "View workout",
} as const;

export function previewFooter(preview: Pick<WorkoutPreviewV1, "displayStatus" | "completedWorkoutSessionId">, previewOnly: boolean): PreviewFooter {
  if (preview.displayStatus === "COMPLETED") {
    return { kind: "COMPLETED", text: PREVIEW_FOOTER_COPY.completed, viewWorkoutHref: preview.completedWorkoutSessionId === undefined ? null : workoutDetailHref(preview.completedWorkoutSessionId) };
  }
  if (previewOnly) return { kind: "PREVIEW_ONLY", text: PREVIEW_FOOTER_COPY.previewOnly };
  return { kind: "START" };
}
