import type { AvailableTimeSetV1 } from "./input.js";

/**
 * Available-Time Adaptation V1 — Time Estimation Policy V1 (locked §8),
 * `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`. The ONE named source for
 * these two constants (§22 — never scattered as unexplained magic numbers
 * elsewhere in this module). These are explicit V1 ESTIMATION constants,
 * not claims about exact real-world duration — a future slice may
 * introduce real learned duration estimates (§25, explicitly deferred);
 * this policy version's own numbers must never silently change under the
 * same `policy: "v1"` identifier once observed.
 */
export const SET_EXECUTION_SECONDS = 30;
export const EXERCISE_SETUP_TRANSITION_SECONDS = 60;

/**
 * For every RETAINED exercise (locked §8): 60s setup/transition, PLUS 30s
 * per retained set (WARM_UP or WORKING, no distinction), PLUS the
 * authored `restSeconds` between retained sets — but NEVER after the last
 * retained set (there is nothing left to rest before). `sets` may be
 * passed in any order; this function sorts by `orderIndex` itself so a
 * caller never has to pre-sort a reduced/filtered subset correctly.
 *
 * An exercise with zero retained sets (fully removed, §6) costs nothing —
 * not even the 60s setup — since the exercise itself is gone from the
 * session.
 */
export function estimateExerciseDurationSeconds(sets: readonly AvailableTimeSetV1[]): number {
  if (sets.length === 0) return 0;

  const ordered = [...sets].sort((a, b) => a.orderIndex - b.orderIndex);
  let totalSeconds = EXERCISE_SETUP_TRANSITION_SECONDS;
  ordered.forEach((set, index) => {
    totalSeconds += SET_EXECUTION_SECONDS;
    const isLastRetainedSet = index === ordered.length - 1;
    if (!isLastRetainedSet) totalSeconds += set.restSeconds;
  });
  return totalSeconds;
}

/** Sums `estimateExerciseDurationSeconds` across every exercise's own retained sets — the whole-session estimate this policy version defines (§8). */
export function estimateSessionDurationSeconds(exerciseSets: readonly (readonly AvailableTimeSetV1[])[]): number {
  return exerciseSets.reduce((sum, sets) => sum + estimateExerciseDurationSeconds(sets), 0);
}
