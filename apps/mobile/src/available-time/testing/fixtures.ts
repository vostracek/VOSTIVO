import type { AvailableTimePreviewExerciseV1, AvailableTimePreviewResponseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { PrescribedSetV1 } from "@vostivo/domain";

/**
 * TEST-ONLY: one internally consistent server pair — the canonical Workout
 * Preview and Available-Time previews of the SAME planned workout (Bench
 * Press 3 working sets at a progressed 62.5kg, Overhead Press 2 sets).
 */
export function fixtureId(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

export const WORKOUT_ID = fixtureId(1);
export const VERSION_ID = fixtureId(2);
export const BENCH_ID = fixtureId(10);
export const OHP_ID = fixtureId(20);
export const BENCH_SETS = [fixtureId(101), fixtureId(102), fixtureId(103)] as const;
export const OHP_SETS = [fixtureId(201), fixtureId(202)] as const;

function set(prescriptionSetId: string, order: number, amountMilli: number): PrescribedSetV1 {
  return {
    prescriptionSetId,
    order,
    targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
    targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis: "TOTAL" },
    restSeconds: 90,
    setType: "WORKING",
  };
}

export function workoutPreview(): WorkoutPreviewV1 {
  return {
    plannedWorkoutId: WORKOUT_ID,
    name: "Upper Body A",
    focus: "Push emphasis",
    estimatedDurationMinutes: 60,
    displayStatus: "TODAY",
    hasActiveSession: false,
    canStart: true,
    exercises: [],
    prescription: {
      schemaVersion: 1,
      prescriptionId: WORKOUT_ID,
      name: "Upper Body A",
      exercises: [
        { prescriptionExerciseId: BENCH_ID, exerciseRef: "bench-press", displayName: "Bench Press", order: 1, sets: BENCH_SETS.map((id, i) => set(id, i + 1, 62500)) },
        { prescriptionExerciseId: OHP_ID, exerciseRef: "overhead-press", displayName: "Overhead Press", order: 2, sets: OHP_SETS.map((id, i) => set(id, i + 1, 30000)) },
      ],
    },
  };
}

function exercise(
  id: string,
  displayName: string,
  tier: "TIER_1" | "TIER_2",
  minimum: number,
  authored: readonly string[],
  retained: readonly string[],
): AvailableTimePreviewExerciseV1 {
  const removed = authored.filter((setId) => !retained.includes(setId));
  return {
    plannedExerciseId: id,
    exerciseRef: displayName === "Bench Press" ? "bench-press" : "overhead-press",
    displayName,
    priorityTier: tier,
    originalWorkingSetCount: authored.length,
    retainedWorkingSetCount: retained.length,
    removedWorkingSetCount: removed.length,
    originalTotalSetCount: authored.length,
    retainedTotalSetCount: retained.length,
    minimumWorkingSets: minimum,
    removedEntireExercise: retained.length === 0,
    retainedPlannedSetIds: [...retained],
    removedPlannedSetIds: removed,
  };
}

function base(availableMinutes: number): Omit<AvailableTimePreviewResponseV1, "result" | "fitsAvailableTime" | "adjustedEstimatedSeconds" | "minimumEstimatedSeconds" | "exercises"> {
  return { policyVersion: "available-time/v1", plannedWorkoutId: WORKOUT_ID, sourceProgramVersionId: VERSION_ID, availableMinutes, originalEstimatedSeconds: 540, previewFingerprint: "f".repeat(64) };
}

/** 5 min: Bench 3 → 2, Overhead Press removed (210s). */
export function adjustPreview(availableMinutes = 5): AvailableTimePreviewResponseV1 {
  return {
    ...base(availableMinutes),
    result: "ADJUST_SESSION",
    fitsAvailableTime: true,
    adjustedEstimatedSeconds: 210,
    minimumEstimatedSeconds: null,
    exercises: [exercise(BENCH_ID, "Bench Press", "TIER_1", 2, BENCH_SETS, BENCH_SETS.slice(0, 2)), exercise(OHP_ID, "Overhead Press", "TIER_2", 0, OHP_SETS, [])],
  };
}

/** 8 min: only OHP loses its last set; Bench is unchanged (must be hidden). */
export function adjustPreviewOhpOnly(): AvailableTimePreviewResponseV1 {
  return {
    ...base(8),
    result: "ADJUST_SESSION",
    fitsAvailableTime: true,
    adjustedEstimatedSeconds: 420,
    minimumEstimatedSeconds: null,
    exercises: [exercise(BENCH_ID, "Bench Press", "TIER_1", 2, BENCH_SETS, BENCH_SETS), exercise(OHP_ID, "Overhead Press", "TIER_2", 0, OHP_SETS, OHP_SETS.slice(0, 1))],
  };
}

export function noChangePreview(availableMinutes = 60): AvailableTimePreviewResponseV1 {
  return {
    ...base(availableMinutes),
    result: "NO_CHANGE",
    fitsAvailableTime: true,
    adjustedEstimatedSeconds: 540,
    minimumEstimatedSeconds: null,
    exercises: [exercise(BENCH_ID, "Bench Press", "TIER_1", 2, BENCH_SETS, BENCH_SETS), exercise(OHP_ID, "Overhead Press", "TIER_2", 0, OHP_SETS, OHP_SETS)],
  };
}

export function cannotFitPreview(availableMinutes = 3): AvailableTimePreviewResponseV1 {
  return {
    ...base(availableMinutes),
    result: "CANNOT_FIT_MINIMUM",
    fitsAvailableTime: false,
    adjustedEstimatedSeconds: 210,
    minimumEstimatedSeconds: 210,
    exercises: [exercise(BENCH_ID, "Bench Press", "TIER_1", 2, BENCH_SETS, BENCH_SETS.slice(0, 2)), exercise(OHP_ID, "Overhead Press", "TIER_2", 0, OHP_SETS, [])],
  };
}
