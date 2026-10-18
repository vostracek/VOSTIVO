import { describe, expect, it } from "vitest";
import type { ActiveWorkoutSession } from "./active-workout-session";
import { computeSessionCompletion } from "./session-completion";

/**
 * Active Workout Finish-blocker fix — regression coverage for the pure
 * completion-detection logic. These correspond to the task's required
 * tests A ("incomplete workout") and B ("all planned sets completed");
 * C/D (canonical finish path reuse, Finish available while resting) are
 * proven by the screen code reusing this exact function and by the
 * header's Finish button rendering unconditionally of rest-timer state
 * (no test harness exists for rendering this screen — see this repo's
 * other `apps/mobile` tests, all pure-logic, no `@testing-library/
 * react-native`); E/F (session/set durability across reload, no
 * duplicate session) are proven by native device verification, this
 * project's established method for local-persistence behavior.
 */
function session(overrides: {
  readonly plannedSetsPerExercise: readonly number[];
  readonly completedSetsPerExercise: readonly number[];
}): ActiveWorkoutSession {
  return {
    id: "session-1",
    startedAt: new Date().toISOString(),
    drafts: [],
    restTimer: null,
    availableTimeApplication: null,
    prescription: {
      schemaVersion: 1,
      prescriptionId: "p1",
      name: "Upper Body A",
      exercises: overrides.plannedSetsPerExercise.map((setCount, exerciseIndex) => ({
        prescriptionExerciseId: `exercise-${exerciseIndex}`,
        exerciseRef: `exercise-ref-${exerciseIndex}`,
        displayName: `Exercise ${exerciseIndex}`,
        order: exerciseIndex + 1,
        sets: Array.from({ length: setCount }, (_, setIndex) => ({
          prescriptionSetId: `exercise-${exerciseIndex}-set-${setIndex}`,
          order: setIndex + 1,
          targetReps: { kind: "RANGE" as const, minReps: 8, maxReps: 12 },
          targetLoad: { kind: "EXTERNAL_WEIGHT" as const, amountMilli: 60000, unit: "KG" as const, basis: "TOTAL" as const },
          restSeconds: 90,
          setType: "WORKING" as const,
        })),
      })),
    },
    exercises: overrides.completedSetsPerExercise.map((completedCount, exerciseIndex) => ({
      id: `performed-exercise-${exerciseIndex}`,
      prescriptionExerciseId: `exercise-${exerciseIndex}`,
      displayName: `Exercise ${exerciseIndex}`,
      order: exerciseIndex + 1,
      sets: Array.from({ length: completedCount }, (_, setIndex) => ({
        id: `performed-set-${exerciseIndex}-${setIndex}`,
        prescriptionSetId: `exercise-${exerciseIndex}-set-${setIndex}`,
        order: setIndex + 1,
        actualReps: 12,
        actualLoad: { kind: "EXTERNAL_WEIGHT" as const, amountMilli: 60000, unit: "KG" as const, basis: "TOTAL" as const },
        setType: "WORKING" as const,
        completionState: "COMPLETED" as const,
        completedAt: new Date().toISOString(),
        revision: 1,
      })),
    })),
  };
}

describe("computeSessionCompletion", () => {
  it("AW-FIN-001: no sets completed — not all complete", () => {
    const result = computeSessionCompletion(session({ plannedSetsPerExercise: [3, 2], completedSetsPerExercise: [0, 0] }));
    expect(result).toEqual({ totalPlannedSets: 5, completedWorkingSets: 0, allSetsComplete: false });
  });

  it("AW-FIN-002: some sets completed across exercises — not all complete", () => {
    const result = computeSessionCompletion(session({ plannedSetsPerExercise: [3, 2], completedSetsPerExercise: [3, 1] }));
    expect(result).toEqual({ totalPlannedSets: 5, completedWorkingSets: 4, allSetsComplete: false });
  });

  it("AW-FIN-003: the exact reported scenario — Bench Press (3/3) + Overhead Press (2/2) — all complete", () => {
    const result = computeSessionCompletion(session({ plannedSetsPerExercise: [3, 2], completedSetsPerExercise: [3, 2] }));
    expect(result).toEqual({ totalPlannedSets: 5, completedWorkingSets: 5, allSetsComplete: true });
  });

  it("AW-FIN-004: a single-exercise workout, fully completed", () => {
    const result = computeSessionCompletion(session({ plannedSetsPerExercise: [4], completedSetsPerExercise: [4] }));
    expect(result.allSetsComplete).toBe(true);
  });

  it("AW-FIN-005: the first exercise complete but the second not yet started — not all complete", () => {
    const result = computeSessionCompletion(session({ plannedSetsPerExercise: [3, 2], completedSetsPerExercise: [3, 0] }));
    expect(result.allSetsComplete).toBe(false);
  });
});
