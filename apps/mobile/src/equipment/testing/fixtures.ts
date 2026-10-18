import type { EquipmentAdaptationOptionsResponseV1, EquipmentAdaptationPreviewResponseV1, EquipmentAdaptationPreviewReplacementV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { PrescribedExerciseV1, PrescribedSetV1 } from "@vostivo/domain";

/**
 * TEST-ONLY: one internally consistent server picture of Upper Body A
 * (Bench Press 3 x 8–12 at 80 kg, Overhead Press 2 x 6–8 at 40 kg) — the
 * equipment options, previews and the authored vs equipment-adjusted
 * EFFECTIVE Workout Preview exactly as the API returns them. Ids/labels are
 * deliberately written out here as SERVER DATA, never imported from a
 * mobile catalog (there is none).
 */
export function fixtureId(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

export const WORKOUT_ID = fixtureId(1);
export const BENCH_ID = fixtureId(10);
export const OHP_ID = fixtureId(20);
export const APPLICATION_ID = fixtureId(30);
export const BENCH_SETS = [fixtureId(101), fixtureId(102), fixtureId(103)] as const;
export const OHP_SETS = [fixtureId(201), fixtureId(202)] as const;
export const CATALOG = "exercise-equipment-catalog/v1";
export const FINGERPRINT_ADJUST = "a".repeat(64);
export const FINGERPRINT_NO_CHANGE = "b".repeat(64);
export const FINGERPRINT_REVIEW = "c".repeat(64);
export const FINGERPRINT_ADJUST_2 = "d".repeat(64);

/** The fixture inventory: dumbbells + both benches, no barbell / rack. */
export const NO_BARBELL = ["flat-bench", "adjustable-bench", "dumbbells"] as const;

export function options(overrides: Partial<EquipmentAdaptationOptionsResponseV1> = {}): EquipmentAdaptationOptionsResponseV1 {
  return {
    schemaVersion: "equipment-adaptation-options/v1",
    catalogVersion: CATALOG,
    plannedWorkoutId: WORKOUT_ID,
    athleteLocalDate: "2026-10-12",
    equipmentOptions: [
      { equipmentId: "barbell", displayLabel: "Barbell (with plates)", relevance: "PLANNED" },
      { equipmentId: "barbell-rack", displayLabel: "Barbell rack / uprights", relevance: "PLANNED" },
      { equipmentId: "flat-bench", displayLabel: "Flat bench", relevance: "PLANNED" },
      { equipmentId: "adjustable-bench", displayLabel: "Adjustable (incline) bench", relevance: "SUBSTITUTE" },
      { equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "SUBSTITUTE" },
    ],
    currentApplication: null,
    ...overrides,
  };
}

const common = (fingerprint: string, inventory: readonly string[]) =>
  ({
    schemaVersion: "equipment-adaptation-preview/v1",
    policyVersion: "equipment-adaptation/v1",
    catalogVersion: CATALOG,
    athleteLocalDate: "2026-10-12",
    plannedWorkoutId: WORKOUT_ID,
    workoutName: "Upper Body A",
    availableEquipmentIds: [...inventory].sort(),
    previewFingerprint: fingerprint,
  }) as const;

function replacement(plannedExerciseId: string, order: number, authored: [string, string], substitute: [string, string], setIds: readonly string[], reps: [number, number]): EquipmentAdaptationPreviewReplacementV1 {
  return {
    plannedExerciseId,
    order,
    authoredExerciseRef: authored[0],
    authoredExerciseName: authored[1],
    substituteExerciseRef: substitute[0],
    substituteExerciseName: substitute[1],
    reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
    prescriptionPolicy: "PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD",
    prescription: {
      workingSetCount: setIds.length,
      sets: setIds.map((plannedSetId, i) => ({ plannedSetId, order: i + 1, setType: "WORKING", targetReps: { kind: "RANGE", minReps: reps[0], maxReps: reps[1] }, restSeconds: 90 })),
      availableTime: null,
      loadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
    },
  };
}

export function adjustPreview(fingerprint: string = FINGERPRINT_ADJUST): EquipmentAdaptationPreviewResponseV1 {
  return {
    ...common(fingerprint, NO_BARBELL),
    result: "ADJUST_SESSION",
    reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
    // Server order is authored order; deliberately listed out of order to prove the UI sorts by `order`.
    replacements: [
      replacement(OHP_ID, 2, ["overhead-press", "Overhead Press"], ["seated-dumbbell-overhead-press", "Seated Dumbbell Overhead Press"], OHP_SETS, [6, 8]),
      replacement(BENCH_ID, 1, ["bench-press", "Bench Press"], ["dumbbell-bench-press", "Dumbbell Bench Press"], BENCH_SETS, [8, 12]),
    ],
  };
}

export function noChangePreview(fingerprint: string = FINGERPRINT_NO_CHANGE): EquipmentAdaptationPreviewResponseV1 {
  return { ...common(fingerprint, ["barbell", "barbell-rack", "flat-bench"]), result: "NO_CHANGE", reasonCode: "ALL_EQUIPMENT_AVAILABLE", replacements: [] };
}

export function reviewRequiredPreview(fingerprint: string = FINGERPRINT_REVIEW): EquipmentAdaptationPreviewResponseV1 {
  return {
    ...common(fingerprint, []),
    result: "REVIEW_REQUIRED",
    reasonCode: "NO_AVAILABLE_SUBSTITUTE",
    unresolved: [{ plannedExerciseId: BENCH_ID, order: 1, authoredExerciseRef: "bench-press", authoredExerciseName: "Bench Press", reasonCode: "NO_AVAILABLE_SUBSTITUTE" }],
  };
}

function set(prescriptionSetId: string, order: number, reps: [number, number], amountMilli: number | null, basis: "TOTAL" | "PER_IMPLEMENT" = "TOTAL"): PrescribedSetV1 {
  return {
    prescriptionSetId,
    order,
    targetReps: { kind: "RANGE", minReps: reps[0], maxReps: reps[1] },
    targetLoad: amountMilli === null ? null : { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis },
    restSeconds: 90,
    setType: "WORKING",
  };
}

const authoredBench = (): PrescribedExerciseV1 => ({ prescriptionExerciseId: BENCH_ID, exerciseRef: "bench-press", displayName: "Bench Press", order: 1, sets: BENCH_SETS.map((id, i) => set(id, i + 1, [8, 12], 80000)) });
const authoredOhp = (): PrescribedExerciseV1 => ({ prescriptionExerciseId: OHP_ID, exerciseRef: "overhead-press", displayName: "Overhead Press", order: 2, sets: OHP_SETS.map((id, i) => set(id, i + 1, [6, 8], 40000)) });

function workoutPreviewWith(exercises: PrescribedExerciseV1[]): WorkoutPreviewV1 {
  return {
    plannedWorkoutId: WORKOUT_ID,
    name: "Upper Body A",
    focus: null,
    estimatedDurationMinutes: 60,
    displayStatus: "TODAY",
    hasActiveSession: false,
    canStart: true,
    exercises: [],
    prescription: { schemaVersion: 1, prescriptionId: WORKOUT_ID, name: "Upper Body A", exercises },
  };
}

/** The authored effective Workout Preview (no application). */
export function authoredWorkoutPreview(): WorkoutPreviewV1 {
  return workoutPreviewWith([authoredBench(), authoredOhp()]);
}

const substitution = (authoredExerciseRef: string, authoredDisplayName: string) =>
  ({
    kind: "TEMPORARY_EQUIPMENT",
    reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
    authoredExerciseRef,
    authoredDisplayName,
    equipmentApplicationId: APPLICATION_ID,
    policyVersion: "equipment-adaptation/v1",
    catalogVersion: CATALOG,
  }) as const;

/**
 * The server's EFFECTIVE, equipment-adjusted Workout Preview: Dumbbell Bench
 * Press carries its OWN last load (24 kg per dumbbell); Seated DB OHP has no
 * history -> `null` targets. The authored 80 kg / 40 kg appear nowhere.
 */
export function adjustedWorkoutPreview(): WorkoutPreviewV1 {
  return workoutPreviewWith([
    { ...authoredBench(), exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", substitution: substitution("bench-press", "Bench Press"), sets: BENCH_SETS.map((id, i) => set(id, i + 1, [8, 12], 24000, "PER_IMPLEMENT")) },
    { ...authoredOhp(), exerciseRef: "seated-dumbbell-overhead-press", displayName: "Seated Dumbbell Overhead Press", substitution: substitution("overhead-press", "Overhead Press"), sets: OHP_SETS.map((id, i) => set(id, i + 1, [6, 8], null)) },
  ]);
}
