import { describe, expect, it } from "vitest";
import type { EquipmentAdaptationPreviewResponseV1 } from "@vostivo/contracts";
import { canonicalizeSessionInventory, computeEquipmentAdaptationPreview, type EquipmentPreviewExerciseRow, type EquipmentPreviewSource } from "./equipment-adaptation-preview.js";

/** Pure Slice B tests against the REAL canonical catalog + seeded edges (no DB). */
const ALL = ["adjustable-bench", "barbell", "barbell-rack", "cable-station", "dumbbells", "flat-bench", "hack-squat-machine", "lat-pulldown-station", "leg-curl-machine", "leg-press-machine"];

function exercise(id: string, exerciseRef: string | null, order: number, displayName = exerciseRef ?? "Freeform"): EquipmentPreviewExerciseRow {
  return {
    plannedExerciseId: id,
    exerciseRef,
    displayName,
    order,
    priorityTier: "TIER_1",
    minimumWorkingSets: 2,
    sets: [
      { plannedSetId: `${id}-w`, order: 1, setType: "WARM_UP", targetReps: { kind: "EXACT", reps: 10 }, restSeconds: 60 },
      { plannedSetId: `${id}-1`, order: 2, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90 },
      { plannedSetId: `${id}-2`, order: 3, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90 },
    ],
  };
}

function source(exercises: EquipmentPreviewExerciseRow[], availableEquipmentIds: string[] = ALL, overrides: Partial<EquipmentPreviewSource> = {}): EquipmentPreviewSource {
  return {
    athleteProfileId: "athlete-1",
    programVersionId: "version-1",
    trainingBlockId: "block-1",
    plannedWorkoutId: "workout-1",
    workoutName: "Upper Body A",
    athleteLocalDate: "2026-10-08",
    effectiveScheduledDate: "2026-10-08",
    canonicalSessionStatus: null,
    exercises,
    availableEquipmentIds: canonical(availableEquipmentIds),
    ...overrides,
  };
}

function canonical(ids: string[]): readonly string[] {
  const result = canonicalizeSessionInventory(ids);
  if (!result.ok) throw new Error(`unknown equipment ${result.unknownEquipmentIds.join(",")}`);
  return result.availableEquipmentIds;
}

function preview(value: EquipmentPreviewSource): EquipmentAdaptationPreviewResponseV1 {
  const outcome = computeEquipmentAdaptationPreview(value);
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.preview;
}

function substitutes(value: EquipmentPreviewSource): [string, string][] {
  const result = preview(value);
  if (result.result !== "ADJUST_SESSION") throw new Error(`expected ADJUST_SESSION, got ${result.result} ${result.reasonCode}`);
  return result.replacements.map((r) => [r.authoredExerciseRef, r.substituteExerciseRef]);
}


describe("equipment adaptation preview (pure, real catalog)", () => {
  it("1/19(no mutation): all equipment available -> NO_CHANGE with no replacements; common fields are server facts", () => {
    expect(preview(source([exercise("pe-1", "bench-press", 1), exercise("pe-2", "barbell-row", 2)]))).toEqual({
      schemaVersion: "equipment-adaptation-preview/v1",
      policyVersion: "equipment-adaptation/v1",
      catalogVersion: "exercise-equipment-catalog/v1",
      athleteLocalDate: "2026-10-08",
      plannedWorkoutId: "workout-1",
      workoutName: "Upper Body A",
      availableEquipmentIds: ALL,
      previewFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      result: "NO_CHANGE",
      reasonCode: "ALL_EQUIPMENT_AVAILABLE",
      replacements: [],
    });
  });

  it("2: barbell out, dumbbells + flat bench -> bench-press -> dumbbell-bench-press", () => {
    expect(substitutes(source([exercise("pe-1", "bench-press", 1, "Bench Press")], ["dumbbells", "flat-bench"]))).toEqual([["bench-press", "dumbbell-bench-press"]]);
  });

  it("3: barbell out, dumbbells -> romanian-deadlift -> dumbbell-romanian-deadlift", () => {
    expect(substitutes(source([exercise("pe-1", "romanian-deadlift", 1)], ["dumbbells"]))).toEqual([["romanian-deadlift", "dumbbell-romanian-deadlift"]]);
  });

  it("4: pulldown station out, cable -> lat-pulldown -> cable-lat-pulldown", () => {
    expect(substitutes(source([exercise("pe-1", "lat-pulldown", 1)], ["cable-station"]))).toEqual([["lat-pulldown", "cable-lat-pulldown"]]);
  });

  it("5: barbell out, cable -> barbell-row -> seated-cable-row", () => {
    expect(substitutes(source([exercise("pe-1", "barbell-row", 1)], ["cable-station", "dumbbells", "adjustable-bench"]))).toEqual([["barbell-row", "seated-cable-row"]]);
  });

  it("6: barbell + cable out, dumbbells + adjustable bench -> chest-supported-dumbbell-row", () => {
    expect(substitutes(source([exercise("pe-1", "barbell-row", 1)], ["dumbbells", "adjustable-bench"]))).toEqual([["barbell-row", "chest-supported-dumbbell-row"]]);
  });

  it.each<[string, string, string[], string]>([
    ["7: squat out, hack squat available", "back-squat", ["hack-squat-machine", "leg-press-machine"], "NO_EQUIVALENT_SUBSTITUTE"],
    ["8: deadlift out, RDL possible only with a barbell", "deadlift", ["dumbbells"], "NO_AVAILABLE_SUBSTITUTE"],
    ["9: only the compatible incline press possible", "bench-press", ["dumbbells", "adjustable-bench"], "NO_EQUIVALENT_SUBSTITUTE"],
    ["10: no curated substitute", "face-pull", [], "NO_CURATED_SUBSTITUTE"],
  ])("%s -> REVIEW_REQUIRED %s", (_label, ref, available, reason) => {
    const result = preview(source([exercise("pe-1", ref, 1, "Authored")], available));
    expect(result).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: reason, unresolved: [{ plannedExerciseId: "pe-1", order: 1, authoredExerciseRef: ref, authoredExerciseName: "Authored", reasonCode: reason }] });
  });

  it("11/12: a null or unknown exerciseRef -> REVIEW_REQUIRED UNSUPPORTED_EXERCISE_IDENTITY, never partially adjusted, never name-matched", () => {
    for (const ref of [null, "Bench Press", "unknown-press"]) {
      const result = preview(source([exercise("pe-1", "bench-press", 1), exercise("pe-2", ref, 2, "Bench Press")], ["dumbbells", "flat-bench"]));
      expect(result).toEqual(expect.objectContaining({ result: "REVIEW_REQUIRED", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY", unresolved: [{ plannedExerciseId: "pe-2", order: 2, authoredExerciseRef: ref, authoredExerciseName: "Bench Press", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY" }] }));
      expect(result).not.toHaveProperty("replacements");
    }
  });

  it("13/14/15/17: inventory canonicalization — unknown ids rejected, duplicates collapse, order irrelevant, [] valid", () => {
    expect(canonicalizeSessionInventory(["dumbbells", "kettlebell", "Barbell"])).toEqual({ ok: false, unknownEquipmentIds: ["Barbell", "kettlebell"] });
    expect(canonicalizeSessionInventory(["flat-bench", "dumbbells", "flat-bench"])).toEqual({ ok: true, availableEquipmentIds: ["dumbbells", "flat-bench"] });
    expect(canonicalizeSessionInventory(["dumbbells", "flat-bench"])).toEqual(canonicalizeSessionInventory(["flat-bench", "dumbbells"]));
    expect(canonicalizeSessionInventory([])).toEqual({ ok: true, availableEquipmentIds: [] });
  });

  it("17: an empty inventory is evaluated: equipment-free exercises stay performable, others need review", () => {
    expect(preview(source([exercise("pe-1", "leg-curl", 1)], []))).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "NO_CURATED_SUBSTITUTE" });
  });

  it("16: equipment order/duplicates never change the result or the fingerprint", () => {
    const a = preview(source([exercise("pe-1", "bench-press", 1)], ["dumbbells", "flat-bench"]));
    const b = preview(source([exercise("pe-1", "bench-press", 1)], ["flat-bench", "dumbbells", "flat-bench"]));
    expect(b).toEqual(a);
  });

  it("18: there is no input path for a client candidate/replacement — candidates come only from the catalog", () => {
    // A substitute that is not a curated edge can never appear, whatever the inventory.
    const result = preview(source([exercise("pe-1", "barbell-row", 1)], ["dumbbells", "flat-bench"]));
    expect(result).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "NO_AVAILABLE_SUBSTITUTE" });
  });

  it("20: no load anywhere in a replacement; the prescription structure is preserved and load must be re-resolved", () => {
    const result = preview(source([exercise("pe-1", "bench-press", 1, "Bench Press")], ["dumbbells", "flat-bench"]));
    if (result.result !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(result.replacements[0]).toEqual({
      plannedExerciseId: "pe-1",
      order: 1,
      authoredExerciseRef: "bench-press",
      authoredExerciseName: "Bench Press",
      substituteExerciseRef: "dumbbell-bench-press",
      substituteExerciseName: "Dumbbell Bench Press",
      reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
      prescriptionPolicy: "PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD",
      prescription: {
        workingSetCount: 2,
        sets: [
          { plannedSetId: "pe-1-w", order: 1, setType: "WARM_UP", targetReps: { kind: "EXACT", reps: 10 }, restSeconds: 60 },
          { plannedSetId: "pe-1-1", order: 2, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90 },
          { plannedSetId: "pe-1-2", order: 3, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90 },
        ],
        availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 2 },
        loadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/targetLoad|amountMilli|"KG"|kg/);
  });

  it("21: unaffected exercises are not in the diff; replacements keep authored order", () => {
    const result = preview(source([exercise("pe-1", "bench-press", 1), exercise("pe-2", "face-pull", 2), exercise("pe-3", "barbell-row", 3)], ["dumbbells", "flat-bench", "cable-station"]));
    if (result.result !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(result.replacements.map((r) => [r.order, r.plannedExerciseId, r.substituteExerciseRef])).toEqual([[1, "pe-1", "dumbbell-bench-press"], [3, "pe-3", "seated-cable-row"]]);
  });

  it("22: repeated previews are identical; exercise row order never matters", () => {
    const rows = [exercise("pe-1", "bench-press", 1), exercise("pe-2", "barbell-row", 2)];
    expect(preview(source(rows, ["dumbbells", "flat-bench", "cable-station"]))).toEqual(preview(source([...rows].reverse(), ["dumbbells", "flat-bench", "cable-station"])));
  });

  it("fingerprint: changes with equipment, prescription, identity, order, local date, effective date, version/block, athlete — not with display names", () => {
    const rows = [exercise("pe-1", "bench-press", 1, "Bench Press"), exercise("pe-2", "barbell-row", 2)];
    const base = preview(source(rows, ["dumbbells", "flat-bench", "cable-station"])).previewFingerprint;
    const variants: EquipmentPreviewSource[] = [
      source(rows, ["dumbbells", "flat-bench"]),
      source([{ ...rows[0]!, sets: rows[0]!.sets.slice(1) }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"]),
      source([{ ...rows[0]!, sets: rows[0]!.sets.map((s) => ({ ...s, restSeconds: 120 })) }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"]),
      source([{ ...rows[0]!, minimumWorkingSets: 1 }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"]),
      source([{ ...rows[0]!, exerciseRef: "overhead-press" }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"]),
      source([{ ...rows[0]!, order: 3 }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"]),
      source(rows, ["dumbbells", "flat-bench", "cable-station"], { athleteLocalDate: "2026-10-09", effectiveScheduledDate: "2026-10-09" }),
      source(rows, ["dumbbells", "flat-bench", "cable-station"], { effectiveScheduledDate: "2026-10-07" }),
      source(rows, ["dumbbells", "flat-bench", "cable-station"], { trainingBlockId: "block-2" }),
      source(rows, ["dumbbells", "flat-bench", "cable-station"], { athleteProfileId: "athlete-2" }),
    ];
    const fingerprints = variants.map((v) => preview(v).previewFingerprint);
    for (const fingerprint of fingerprints) expect(fingerprint).not.toBe(base);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(preview(source([{ ...rows[0]!, displayName: "Renamed" }, rows[1]!], ["dumbbells", "flat-bench", "cable-station"], { workoutName: "Renamed" })).previewFingerprint).toBe(base);
  });

  it("an authored Available-Time minimum above the working set count is an invalid prescription (422), never a guess", () => {
    expect(computeEquipmentAdaptationPreview(source([{ ...exercise("pe-1", "bench-press", 1), minimumWorkingSets: 5 }]))).toEqual({ ok: false, code: "EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION" });
  });
});
