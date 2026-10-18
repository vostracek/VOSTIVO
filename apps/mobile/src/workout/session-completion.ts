import type { ActiveWorkoutSession } from "./active-workout-session";

/**
 * Active Workout Finish-blocker fix — the single source of truth for
 * "how many planned sets exist, how many are actually logged." Extracted
 * as a pure, screen-independent function (no React/expo-router import)
 * specifically so it is directly unit-testable without the component-
 * testing infrastructure this repo does not have (no `@testing-library/
 * react-native`/jest-expo preset — every other mobile test in this repo
 * is a pure-logic test for exactly this reason).
 *
 * Root cause this exists to fix: the Active Workout screen's only
 * bottom-of-exercise primary action ("LOG SET N") rendered exclusively
 * for the current/first-incomplete set of the CURRENT exercise. Once
 * every set of the current (and, for the last exercise, every remaining)
 * exercise was complete, no row was ever "current," so that action area
 * silently disappeared with nothing replacing it — leaving only the
 * header's small icon-only Finish button, which a real athlete did not
 * recognize as a finish affordance. `allSetsComplete` here drives the
 * new, clearly-labeled "Finish Workout" CTA that replaces it.
 */
export function computeSessionCompletion(session: ActiveWorkoutSession): {
  readonly totalPlannedSets: number;
  readonly completedWorkingSets: number;
  readonly allSetsComplete: boolean;
} {
  const totalPlannedSets = session.prescription.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
  const completedWorkingSets = session.exercises.reduce(
    (sum, ex) => sum + ex.sets.filter((s) => s.completionState === "COMPLETED").length,
    0,
  );
  return { totalPlannedSets, completedWorkingSets, allSetsComplete: completedWorkingSets >= totalPlannedSets };
}
