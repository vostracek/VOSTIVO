import { describe, expect, it } from "vitest";
import { exerciseEquipmentCatalogV1 } from "@vostivo/domain";
import { catalogEquipmentFacts } from "./catalog-adapter.js";
import type { EquipmentAdaptationDecisionDataV1 } from "./decision-data.js";
import type { EquipmentAdaptationExerciseV1 } from "./input.js";
import { evaluateEquipmentAdaptation } from "./policy.js";

/**
 * Curated Substitution Seed V1 — the REAL canonical catalog feeding the
 * unchanged `equipment-adaptation/v1` policy (no test-local edges here).
 */
const KG = (kg: number) => ({ kind: "EXTERNAL_WEIGHT" as const, amountMilli: kg * 1000, unit: "KG" as const, basis: "TOTAL" as const });

function slot(plannedExerciseId: string, exerciseRef: string, order: number): EquipmentAdaptationExerciseV1 {
  const facts = catalogEquipmentFacts(exerciseEquipmentCatalogV1, exerciseRef);
  if (facts.kind !== "SUPPORTED") throw new Error(`${exerciseRef} is not catalog-backed`);
  return {
    plannedExerciseId,
    exerciseId: facts.exerciseId,
    order,
    requiredEquipmentIds: facts.requiredEquipmentIds,
    substitutionPolicy: "ALLOW_TEMPORARY",
    sets: [
      { plannedSetId: `${plannedExerciseId}-w`, order: 1, setType: "WARM_UP", targetReps: { kind: "EXACT", reps: 8 }, restSeconds: 60, targetLoad: KG(40) },
      { plannedSetId: `${plannedExerciseId}-1`, order: 2, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90, targetLoad: KG(60) },
      { plannedSetId: `${plannedExerciseId}-2`, order: 3, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90, targetLoad: KG(60) },
    ],
    availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 1 },
    candidates: facts.candidates,
  };
}

function decide(exerciseRef: string, availableEquipmentIds: string[]): EquipmentAdaptationDecisionDataV1 {
  const result = evaluateEquipmentAdaptation({ exercises: [slot("pe-1", exerciseRef, 1)], availableEquipmentIds, athleteBlockedExerciseIds: [] });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.data;
}

function substituteOf(data: EquipmentAdaptationDecisionDataV1): string {
  if (data.resultKind !== "ADJUST_SESSION") throw new Error(`expected ADJUST_SESSION, got ${data.resultKind} ${data.reasonCode}`);
  return data.replacements[0]!.substituteExerciseId;
}

describe("Curated Substitution Seed V1 — real catalog through equipment-adaptation/v1", () => {
  it("11: barbell unavailable, dumbbells + flat bench available: bench-press -> dumbbell-bench-press (never the compatible incline press)", () => {
    expect(substituteOf(decide("bench-press", ["dumbbells", "flat-bench", "adjustable-bench", "barbell-rack"]))).toBe("dumbbell-bench-press");
  });

  it("10: with the equivalent unavailable, the ROLE_COMPATIBLE incline press is still NOT auto-selected", () => {
    // Dumbbells + adjustable bench (incline press possible), but no flat bench for the equivalent.
    expect(decide("bench-press", ["dumbbells", "adjustable-bench"])).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" });
  });

  it("12: barbell unavailable, dumbbells available: romanian-deadlift -> dumbbell-romanian-deadlift", () => {
    expect(substituteOf(decide("romanian-deadlift", ["dumbbells"]))).toBe("dumbbell-romanian-deadlift");
  });

  it("13: lat-pulldown station unavailable, cable station available: lat-pulldown -> cable-lat-pulldown", () => {
    expect(substituteOf(decide("lat-pulldown", ["cable-station"]))).toBe("cable-lat-pulldown");
  });

  it("14: barbell unavailable, cable available: barbell-row -> seated-cable-row (priority 1)", () => {
    expect(substituteOf(decide("barbell-row", ["cable-station", "dumbbells", "adjustable-bench"]))).toBe("seated-cable-row");
  });

  it("15: barbell and cable unavailable, dumbbells + adjustable bench available: barbell-row -> chest-supported-dumbbell-row (priority 2)", () => {
    expect(substituteOf(decide("barbell-row", ["dumbbells", "adjustable-bench"]))).toBe("chest-supported-dumbbell-row");
  });

  it("overhead-press -> seated-dumbbell-overhead-press when the barbell is out", () => {
    expect(substituteOf(decide("overhead-press", ["dumbbells", "adjustable-bench"]))).toBe("seated-dumbbell-overhead-press");
  });

  it("16: back-squat unavailable with the hack squat machine available -> still REVIEW_REQUIRED (only ROLE_COMPATIBLE exists)", () => {
    expect(decide("back-squat", ["hack-squat-machine", "leg-press-machine"])).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" });
  });

  it("17: deadlift unavailable with an RDL possible -> still REVIEW_REQUIRED", () => {
    // Without a barbell neither deadlift nor RDL is possible; the only curated edge (RDL) is compatible anyway.
    expect(decide("deadlift", [])).toMatchObject({ resultKind: "REVIEW_REQUIRED" });
    const deadliftCandidates = slot("pe-1", "deadlift", 1).candidates;
    expect(deadliftCandidates.map((c) => [c.substituteExerciseId, c.compatibilityTier])).toEqual([["romanian-deadlift", "ROLE_COMPATIBLE"]]);
  });

  it("an exercise with no curated substitute (leg-curl, face-pull) -> REVIEW_REQUIRED NO_CURATED_SUBSTITUTE", () => {
    expect(decide("leg-curl", [])).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_CURATED_SUBSTITUTE" });
    expect(decide("face-pull", [])).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_CURATED_SUBSTITUTE" });
  });

  it("18/19: load is absent from the decision and the substitute keeps its own identity", () => {
    const data = decide("bench-press", ["dumbbells", "flat-bench"]);
    if (data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(data.replacements[0]).toMatchObject({ authoredExerciseId: "bench-press", substituteExerciseId: "dumbbell-bench-press" });
    expect(JSON.stringify(data)).not.toMatch(/targetLoad|amountMilli|"KG"/);
    expect(data.replacements[0]!.prescription.workingLoadResolution).toBe("RESOLVE_FOR_SUBSTITUTE_EXERCISE");
  });

  it("a whole real session: only the affected slots change, in place", () => {
    const exercises = [slot("pe-bench", "bench-press", 1), slot("pe-row", "barbell-row", 2), slot("pe-pull", "lat-pulldown", 3), slot("pe-face", "face-pull", 4)];
    const result = evaluateEquipmentAdaptation({ exercises, availableEquipmentIds: ["dumbbells", "flat-bench", "cable-station", "lat-pulldown-station"], athleteBlockedExerciseIds: [] });
    expect(result.ok && result.value.data).toMatchObject({
      resultKind: "ADJUST_SESSION",
      session: [
        { plannedExerciseId: "pe-bench", effectiveExerciseId: "dumbbell-bench-press", substituted: true },
        { plannedExerciseId: "pe-row", effectiveExerciseId: "seated-cable-row", substituted: true },
        { plannedExerciseId: "pe-pull", effectiveExerciseId: "lat-pulldown", substituted: false },
        { plannedExerciseId: "pe-face", effectiveExerciseId: "face-pull", substituted: false },
      ],
    });
  });
});
