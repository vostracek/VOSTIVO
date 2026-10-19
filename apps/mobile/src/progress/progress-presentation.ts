import type {
  ExerciseExposureV1,
  ExerciseHistoryPageV1,
  ProgressImprovementV1,
  ProgressOverviewV1,
  ProgressPerformedSetV1,
  ProgressSnapshotV1,
  WorkoutHistoryDetailV1,
  WorkoutHistoryExerciseV1,
  WorkoutHistoryItemV1,
  WorkoutHistoryProgressionEventV1,
} from "@vostivo/contracts";
import { formatLoad } from "../workout/format-target";
import { shortDayLabel } from "../missed-workout/missed-workout-flow";

/**
 * Progress & Feedback V1 — Slice B: every Progress string, derived ONLY
 * from server facts (Slice A contracts). INTERPRET, DON'T DUMP DATA — but
 * never claim more than the evidence: no score, percentage, streak, trend
 * or "stronger". Pure and framework-free, so the copy rules are unit-tested.
 */

/** GET /progress returns at most this many recent workouts (Slice A contract). */
export const RECENT_WORKOUTS_PREVIEW_LIMIT = 5;

export interface ProgressInterpretation {
  readonly headline: string;
  readonly supporting: string;
}

/** The top answer to "Am I getting better?" — "progress" only when an APPLIED improvement exists. */
export function progressInterpretation(overview: ProgressOverviewV1): ProgressInterpretation {
  const names = uniqueInOrder(overview.improving.map((item) => item.exerciseDisplayName));
  if (names.length === 0) {
    return { headline: "Building your progress picture", supporting: "Keep training consistently and Vostivo will surface meaningful changes here." };
  }
  if (names.length === 1) return { headline: "You're making progress", supporting: `${names[0]!} is moving forward.` };
  if (names.length === 2) return { headline: "You're making progress", supporting: `${names[0]!} and ${names[1]!} are moving forward.` };
  return { headline: "You're making progress", supporting: `${names[0]!}, ${names[1]!} and ${names.length - 2} more are moving forward.` };
}

export type SnapshotView =
  /** Neither signal is available (no current cycle, or a plan configuration problem) — history stays usable. */
  | { readonly kind: "UNAVAILABLE"; readonly message: string }
  | {
      readonly kind: "AVAILABLE";
      readonly block: { readonly title: string; readonly subtitle: string } | null;
      readonly consistency: string | null;
    };

/** Exactly the server's two signals: "Week X of N · block" and "N of M planned workouts completed" — never a percentage. */
export function snapshotView(snapshot: ProgressSnapshotV1): SnapshotView {
  if (snapshot.block === null && snapshot.thisWeek === null) return { kind: "UNAVAILABLE", message: "Current plan progress unavailable" };
  const week = snapshot.thisWeek;
  return {
    kind: "AVAILABLE",
    block: snapshot.block === null ? null : { title: `Week ${snapshot.block.cycleOrder} of ${snapshot.block.cycleCount}`, subtitle: snapshot.block.name },
    consistency:
      week === null
        ? null
        : week.due === 0 && week.completed === 0
          ? "No workouts due yet this week"
          : `${week.completed} of ${week.due} planned ${week.due === 1 ? "workout" : "workouts"} completed`,
  };
}

export interface ImprovementView {
  readonly key: string;
  /** The exact identity to open — a substitute's own ref, never the authored one. */
  readonly exerciseRef: string;
  readonly title: string;
  /** "60kg → 62.5kg" */
  readonly change: string;
  /** What it was based on, e.g. "From 60kg × 12, 12, 12"; `null` when the server returned no sets. */
  readonly evidence: string | null;
  /** Only when the server returned a next exposure. */
  readonly next: string | null;
  /** Navigation to the EXACT next-exposure workout the server returned (read-only preview); `null` without one. */
  readonly nextWorkout: { readonly plannedWorkoutId: string; readonly accessibilityLabel: string } | null;
  /** The exercise-history part of the card. */
  readonly accessibilityLabel: string;
}

export function improvementView(item: ProgressImprovementV1, athleteLocalDate: string | null): ImprovementView {
  const change = `${formatLoad(item.fromLoad)} → ${formatLoad(item.toLoad)}`;
  const evidence = item.basedOn.sets.length === 0 ? null : `From ${formatSets(item.basedOn.sets)}`;
  const exposure = item.nextExposure;
  const next =
    exposure === null
      ? null
      : `Next time · ${formatLoad(item.toLoad)} · ${exposure.workoutName}${exposure.scheduledDate !== null && athleteLocalDate !== null ? `, ${shortDayLabel(exposure.scheduledDate, athleteLocalDate)}` : ""}`;
  return {
    key: item.applicationId,
    exerciseRef: item.exerciseRef,
    title: item.exerciseDisplayName,
    change,
    evidence,
    next,
    nextWorkout: exposure === null || next === null ? null : { plannedWorkoutId: exposure.plannedWorkoutId, accessibilityLabel: `View next workout. ${next}` },
    accessibilityLabel: [`${item.exerciseDisplayName}, ${formatLoad(item.fromLoad)} to ${formatLoad(item.toLoad)}`, evidence, "Opens exercise history"].filter((part) => part !== null).join(". "),
  };
}

export interface WorkoutRowView {
  readonly key: string;
  readonly workoutSessionId: string;
  readonly title: string;
  readonly dateLabel: string;
  /** "4 of 5 working sets" */
  readonly setsLabel: string;
  /** Text, never color alone. */
  readonly completionLabel: "Full" | "Partial";
  readonly tags: readonly string[];
  readonly accessibilityLabel: string;
}

export function workoutRowView(item: WorkoutHistoryItemV1): WorkoutRowView {
  const dateLabel = formatLocalDay(item.completedLocalDate);
  const setsLabel = `${item.completedWorkingSets} of ${item.plannedWorkingSets} working sets`;
  const completionLabel = item.completion === "FULL" ? "Full" : "Partial";
  const tags = adaptationTags(item);
  return {
    key: item.workoutSessionId,
    workoutSessionId: item.workoutSessionId,
    title: item.workoutName,
    dateLabel,
    setsLabel,
    completionLabel,
    tags,
    accessibilityLabel: [item.workoutName, dateLabel, setsLabel, completionLabel === "Full" ? "Completed in full" : "Partially completed", ...tags, "Opens workout details"].join(". "),
  };
}

/** Only what the server says happened: an Available-Time adjusted start, an equipment substitute. */
export function adaptationTags(item: WorkoutHistoryItemV1): string[] {
  const tags: string[] = [];
  if (item.adaptations.availableTime) tags.push("Time adjusted");
  if (item.adaptations.equipment) tags.push("Equipment adjusted");
  return tags;
}

/** "Show more history" is offered only when the root preview may be truncated (it is capped server-side). */
export function shouldOfferWorkoutHistory(overview: ProgressOverviewV1): boolean {
  return overview.recentWorkouts.length >= RECENT_WORKOUTS_PREVIEW_LIMIT;
}

export interface WorkoutDetailView {
  readonly title: string;
  readonly meta: string;
  readonly summary: string;
  readonly provenance: readonly string[];
  readonly exercises: readonly WorkoutExerciseView[];
  readonly progression: readonly string[];
}

export interface WorkoutExerciseView {
  readonly key: string;
  readonly title: string;
  /** Opens exercise history for the PERFORMED identity; `null` = not performed / no identity. */
  readonly exerciseRef: string | null;
  readonly note: string | null;
  readonly sets: readonly string[];
  readonly emptyLabel: string | null;
}

export function workoutDetailView(detail: WorkoutHistoryDetailV1): WorkoutDetailView {
  const { workout } = detail;
  const provenance: string[] = [];
  if (detail.availableTime !== null) provenance.push(`Time adjusted · ${detail.availableTime.availableMinutes} min available`);
  else if (workout.adaptations.availableTime) provenance.push("Time adjusted");
  if (workout.adaptations.equipment) provenance.push("Equipment adjusted for this session");
  return {
    title: workout.workoutName,
    meta: `${formatLocalDay(workout.completedLocalDate)} · ${formatDuration(workout.durationSeconds)}`,
    summary: `${workout.completedWorkingSets} of ${workout.plannedWorkingSets} working sets · ${workout.completion === "FULL" ? "Completed in full" : "Partially completed"}`,
    provenance,
    exercises: detail.exercises.map(workoutExerciseView),
    progression: detail.progressionEvents.map(progressionEventLine),
  };
}

function workoutExerciseView(exercise: WorkoutHistoryExerciseV1, index: number): WorkoutExerciseView {
  return {
    key: `${index}:${exercise.exerciseRef ?? exercise.displayName}`,
    title: exercise.displayName,
    exerciseRef: exercise.sets.length > 0 ? exercise.exerciseRef : null,
    note: exercise.substitution === null ? null : `Instead of ${exercise.substitution.authoredDisplayName}`,
    sets: exercise.sets.map(setLine),
    emptyLabel: exercise.sets.length === 0 ? "Not performed" : null,
  };
}

function progressionEventLine(event: WorkoutHistoryProgressionEventV1): string {
  return `Next target raised · ${formatLoad(event.fromLoad)} → ${formatLoad(event.toLoad)}`;
}

/** "Warm-up · 20kg × 10" / "Set 2 · 60kg × 12" — completed sets only (the server returns nothing else). */
export function setLine(set: ProgressPerformedSetV1): string {
  return `${set.setType === "WARM_UP" ? "Warm-up" : `Set ${set.order}`} · ${formatLoad(set.load)} × ${set.reps}`;
}

export interface ExerciseHistoryHeaderView {
  readonly title: string;
  /** Factual, from the newest loaded exposure — never a trend, e1RM or tonnage. */
  readonly interpretation: string | null;
}

export function exerciseHistoryHeaderView(page: Pick<ExerciseHistoryPageV1, "displayName">, exposures: readonly ExerciseExposureV1[]): ExerciseHistoryHeaderView {
  const latest = exposures[0];
  return {
    title: page.displayName,
    interpretation: latest === undefined ? null : `Last performed ${formatLocalDay(latest.completedLocalDate)}${workingSummary(latest.sets) === null ? "" : ` · ${workingSummary(latest.sets)!}`}`,
  };
}

export interface ExposureView {
  readonly key: string;
  readonly dateLabel: string;
  readonly context: string;
  readonly sets: string;
  readonly accessibilityLabel: string;
}

export function exposureView(exposure: ExerciseExposureV1): ExposureView {
  const dateLabel = formatLocalDay(exposure.completedLocalDate);
  const context = exposure.isSubstitute ? `${exposure.workoutName} · equipment substitute` : exposure.workoutName;
  const sets = exposure.sets.length === 0 ? "No completed sets" : formatSets(exposure.sets);
  return { key: exposureKey(exposure), dateLabel, context, sets, accessibilityLabel: `${dateLabel}. ${context}. ${sets}` };
}

/** Row identity for paging: the contract has no per-exposure id, so session + completion + the sets themselves. */
export function exposureKey(exposure: ExerciseExposureV1): string {
  return `${exposure.workoutSessionId}|${exposure.completedAt}|${exposure.sets.map((s) => `${s.order}:${s.reps}:${s.load.amountMilli}`).join(",")}`;
}

/** Working sets only, e.g. "60kg × 12, 12, 12"; `null` when none were completed. */
function workingSummary(sets: readonly ProgressPerformedSetV1[]): string | null {
  const working = sets.filter((s) => s.setType === "WORKING");
  return working.length === 0 ? null : formatSets(working);
}

/** Consecutive sets at the same load are grouped: "20kg × 10 · 60kg × 12, 12, 12". */
export function formatSets(sets: readonly ProgressPerformedSetV1[]): string {
  const groups: { load: string; reps: number[] }[] = [];
  for (const set of sets) {
    const load = formatLoad(set.load);
    const last = groups.at(-1);
    if (last !== undefined && last.load === load) last.reps.push(set.reps);
    else groups.push({ load, reps: [set.reps] });
  }
  return groups.map((g) => `${g.load} × ${g.reps.join(", ")}`).join(" · ");
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * "Mon 19 Oct" for a server-provided athlete-local calendar day
 * (`YYYY-MM-DD`, e.g. `completedLocalDate`). Pure calendar arithmetic on a
 * UTC-midnight instant read back with UTC getters — the device zone can
 * never shift the day (a travelling athlete's old workouts keep their day).
 * Never pass an instant here, and never derive a history day from
 * `completedAt` on the phone.
 */
export function formatLocalDay(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00.000Z`);
  return `${WEEKDAYS_SHORT[day.getUTCDay()]!} ${day.getUTCDate()} ${MONTHS_SHORT[day.getUTCMonth()]!}`;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}
