import { describe, expect, it } from "vitest";
import { createExerciseEquipmentCatalogLookup, exerciseEquipmentCatalogV1, type ExerciseEquipmentCatalogV1 } from "@vostivo/domain";
import { catalogEquipmentFacts } from "./catalog-adapter.js";
import type { EquipmentAdaptationExerciseV1 } from "./input.js";
import { evaluateEquipmentAdaptation } from "./policy.js";

/** Test-local catalog (NOT product data, NOT a physiological claim) to exercise edge mapping. */
const TEST_CATALOG: ExerciseEquipmentCatalogV1 = {
  version: "test-catalog",
  equipment: [
    { equipmentId: "eq-machine", displayLabel: "Machine" },
    { equipmentId: "eq-dumbbells", displayLabel: "Dumbbells" },
  ],
  exercises: [
    { exerciseRef: "machine-press", displayName: "Machine Press", requiredEquipmentIds: ["eq-machine"] },
    { exerciseRef: "dumbbell-press", displayName: "Dumbbell Press", requiredEquipmentIds: ["eq-dumbbells"] },
    { exerciseRef: "push-up", displayName: "Push-up", requiredEquipmentIds: [] },
    // Name-similar but NOT linked by any edge — must never become a candidate.
    { exerciseRef: "machine-press-incline", displayName: "Machine Press (Incline)", requiredEquipmentIds: [] },
  ],
  substitutions: [
    { sourceExerciseRef: "machine-press", substituteExerciseRef: "push-up", compatibilityTier: "ROLE_COMPATIBLE", substitutionPriority: 2, prescriptionCompatibility: "REQUIRES_PRESCRIPTION_CHANGE" },
    { sourceExerciseRef: "machine-press", substituteExerciseRef: "dumbbell-press", compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority: 1, prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION" },
  ],
};
const lookup = createExerciseEquipmentCatalogLookup(TEST_CATALOG);

function engineExercise(plannedExerciseId: string, exerciseRef: string, order: number): EquipmentAdaptationExerciseV1 {
  const facts = catalogEquipmentFacts(lookup, exerciseRef);
  if (facts.kind !== "SUPPORTED") throw new Error("expected a catalog-backed exercise");
  return {
    plannedExerciseId,
    exerciseId: facts.exerciseId,
    order,
    requiredEquipmentIds: facts.requiredEquipmentIds,
    substitutionPolicy: "ALLOW_TEMPORARY",
    sets: [{ plannedSetId: `${plannedExerciseId}-s1`, order: 1, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90, targetLoad: null }],
    availableTime: null,
    candidates: facts.candidates,
  };
}

describe("catalog -> equipment-adaptation/v1 adapter", () => {
  it("28: provides Slice-A required-equipment input for canonical exercises (ALL-OF; [] = independent)", () => {
    expect(catalogEquipmentFacts(exerciseEquipmentCatalogV1, "bench-press")).toMatchObject({ kind: "SUPPORTED", exerciseId: "bench-press", requiredEquipmentIds: ["barbell", "barbell-rack", "flat-bench"], candidates: [{ substituteExerciseId: "dumbbell-bench-press", requiredEquipmentIds: ["dumbbells", "flat-bench"] }, { substituteExerciseId: "incline-dumbbell-press", compatibilityTier: "ROLE_COMPATIBLE" }] });
    expect(catalogEquipmentFacts(lookup, "push-up")).toMatchObject({ kind: "SUPPORTED", requiredEquipmentIds: [] });
  });

  it("9/16: null or unknown identity -> UNSUPPORTED_EXERCISE_IDENTITY (never 'no equipment needed', never name-matched)", () => {
    expect(catalogEquipmentFacts(exerciseEquipmentCatalogV1, null)).toEqual({ kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "NULL_EXERCISE_REF" });
    expect(catalogEquipmentFacts(exerciseEquipmentCatalogV1, "Bench Press")).toEqual({ kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "UNKNOWN_EXERCISE_REF" });
  });

  it("29: curated candidates come only from explicit edges, priority-ordered, with the substitute's own equipment — no name inference, no pre-filtering", () => {
    const facts = catalogEquipmentFacts(lookup, "machine-press");
    expect(facts).toEqual({
      kind: "SUPPORTED",
      exerciseId: "machine-press",
      requiredEquipmentIds: ["eq-machine"],
      candidates: [
        { substituteExerciseId: "dumbbell-press", compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority: 1, requiredEquipmentIds: ["eq-dumbbells"], prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION" },
        { substituteExerciseId: "push-up", compatibilityTier: "ROLE_COMPATIBLE", substitutionPriority: 2, requiredEquipmentIds: [], prescriptionCompatibility: "REQUIRES_PRESCRIPTION_CHANGE" },
      ],
    });
    expect(JSON.stringify(facts)).not.toContain("machine-press-incline");
    // Directional: the substitute does not get a reverse edge.
    expect(catalogEquipmentFacts(lookup, "dumbbell-press")).toMatchObject({ candidates: [] });
  });

  it("returned candidate arrays are copies — mutating them never touches catalog data", () => {
    const facts = catalogEquipmentFacts(lookup, "machine-press");
    if (facts.kind !== "SUPPORTED") throw new Error("expected SUPPORTED");
    (facts.candidates[0]!.requiredEquipmentIds as string[]).push("eq-x");
    expect(lookup.getExerciseDefinition("dumbbell-press")?.requiredEquipmentIds).toEqual(["eq-dumbbells"]);
  });

  it("end to end: catalog facts feed the unchanged Slice A policy (equipment/blocks decided there, once)", () => {
    const exercises = [engineExercise("pe-1", "machine-press", 1), engineExercise("pe-2", "push-up", 2)];
    const adjusted = evaluateEquipmentAdaptation({ exercises, availableEquipmentIds: ["eq-dumbbells"], athleteBlockedExerciseIds: [] });
    expect(adjusted.ok && adjusted.value.data).toMatchObject({ resultKind: "ADJUST_SESSION", replacements: [{ authoredExerciseId: "machine-press", substituteExerciseId: "dumbbell-press" }] });
    const blocked = evaluateEquipmentAdaptation({ exercises, availableEquipmentIds: ["eq-dumbbells"], athleteBlockedExerciseIds: ["dumbbell-press"] });
    expect(blocked.ok && blocked.value.data).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" });
  });

  it("the canonical catalog: leg-press has only ROLE_COMPATIBLE edges -> never automatic (REVIEW_REQUIRED)", () => {
    const facts = catalogEquipmentFacts(exerciseEquipmentCatalogV1, "leg-press");
    if (facts.kind !== "SUPPORTED") throw new Error("expected SUPPORTED");
    const result = evaluateEquipmentAdaptation({
      exercises: [{ plannedExerciseId: "pe-1", exerciseId: facts.exerciseId, order: 1, requiredEquipmentIds: facts.requiredEquipmentIds, substitutionPolicy: "ALLOW_TEMPORARY", sets: [], availableTime: null, candidates: facts.candidates }],
      availableEquipmentIds: ["hack-squat-machine", "barbell", "barbell-rack"],
      athleteBlockedExerciseIds: [],
    });
    expect(result.ok && result.value.data).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" });
  });
});
