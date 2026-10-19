/** Progress drill-down routes. Ids/refs are server values, only URL-encoded for transport. */
export function workoutDetailHref(workoutSessionId: string): `/progress/workouts/${string}` {
  return `/progress/workouts/${encodeURIComponent(workoutSessionId)}`;
}

/** The PERFORMED exercise identity — a substitute's own ref, never mapped to the authored exercise. */
export function exerciseHistoryHref(exerciseRef: string): `/progress/exercises/${string}` {
  return `/progress/exercises/${encodeURIComponent(exerciseRef)}`;
}

/**
 * The exact next-exposure workout the server returned, opened from Progress
 * as a READ-ONLY preview (context, never a deep-link START).
 */
export function nextWorkoutPreviewHref(plannedWorkoutId: string): `/workout/${string}` {
  return `/workout/${encodeURIComponent(plannedWorkoutId)}?source=progress`;
}

/** Workout Preview opened from Progress shows no Start action. */
export function isPreviewOnlySource(source: string | string[] | undefined): boolean {
  return source === "progress";
}
