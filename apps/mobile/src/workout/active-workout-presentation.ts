import type { ExternalWeightLoad, PrescribedExerciseV1, PrescribedSetV1, WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { ActivePerformedSet } from "./active-workout-session";
import type { PreviousSetPerformance } from "./workout-repository";

/**
 * Active Workout's pure presentation rules (extracted from
 * `app/active-workout.tsx` so they are unit-testable; behavior unchanged).
 *
 * Identity: everything is keyed by the snapshot exercise's PERFORMED
 * `exerciseRef`. For a temporary equipment substitute that is the substitute
 * (e.g. Dumbbell Bench Press) — its own Previous, its own load — never the
 * authored exercise kept in `substitution.authoredExerciseRef`, which is
 * provenance only and is deliberately never read here.
 */

/** The distinct performed exercise identities whose Previous performance is looked up (spec section 9). */
export function previousPerformanceRefs(prescription: Pick<WorkoutPrescriptionV1, "exercises">): string[] {
  return [...new Set(prescription.exercises.map((e) => e.exerciseRef).filter((r): r is string => r !== null))];
}

/** The Previous sets shown for one exercise — by its performed identity only. */
export function previousSetsFor(exercise: Pick<PrescribedExerciseV1, "exerciseRef">, previousByExerciseRef: ReadonlyMap<string, readonly PreviousSetPerformance[]>): readonly PreviousSetPerformance[] | undefined {
  return exercise.exerciseRef !== null ? previousByExerciseRef.get(exercise.exerciseRef) : undefined;
}

/**
 * Input prefill priority (spec section 12): 1. already-completed actual
 * value, 2. a saved draft, 3. the prescription target where it is a
 * single concrete value (never an arbitrary bound of a RANGE), 4. Previous
 * performance where safe, 5. empty. Never overwrites explicit athlete
 * input — this only runs once per set identity (see the `initializedFor`
 * guard in `SetRow`).
 */
export function resolvePrefill(
  plannedSet: PrescribedSetV1,
  performedSet: ActivePerformedSet | undefined,
  draft: { readonly draftReps: number | null; readonly draftLoad: ExternalWeightLoad | null } | undefined,
  previous: PreviousSetPerformance | undefined,
): { reps: string; load: string; unit: ExternalWeightLoad["unit"]; basis: ExternalWeightLoad["basis"] } {
  const defaultUnit: ExternalWeightLoad["unit"] = plannedSet.targetLoad?.unit ?? previous?.actualLoad.unit ?? "KG";
  const defaultBasis: ExternalWeightLoad["basis"] = plannedSet.targetLoad?.basis ?? previous?.actualLoad.basis ?? "TOTAL";

  if (performedSet !== undefined) {
    return {
      reps: String(performedSet.actualReps),
      load: String(performedSet.actualLoad.amountMilli / 1000),
      unit: performedSet.actualLoad.unit,
      basis: performedSet.actualLoad.basis,
    };
  }
  if (draft !== undefined && (draft.draftReps !== null || draft.draftLoad !== null)) {
    return {
      reps: draft.draftReps !== null ? String(draft.draftReps) : "",
      load: draft.draftLoad !== null ? String(draft.draftLoad.amountMilli / 1000) : "",
      unit: draft.draftLoad?.unit ?? defaultUnit,
      basis: draft.draftLoad?.basis ?? defaultBasis,
    };
  }
  const targetReps = plannedSet.targetReps?.kind === "EXACT" ? String(plannedSet.targetReps.reps) : "";
  const targetLoad = plannedSet.targetLoad !== null ? String(plannedSet.targetLoad.amountMilli / 1000) : "";
  if (targetReps !== "" || targetLoad !== "") {
    return { reps: targetReps, load: targetLoad, unit: defaultUnit, basis: defaultBasis };
  }
  if (previous !== undefined) {
    return {
      reps: String(previous.actualReps),
      load: String(previous.actualLoad.amountMilli / 1000),
      unit: previous.actualLoad.unit,
      basis: previous.actualLoad.basis,
    };
  }
  return { reps: "", load: "", unit: defaultUnit, basis: defaultBasis };
}
