import { describe, expect, it } from "vitest";
import { exerciseEquipmentCatalogV1 } from "@vostivo/domain";
import { computeEquipmentAdaptationOptions } from "./equipment-adaptation-options.js";

describe("computeEquipmentAdaptationOptions (Temporary Equipment V1 Slice D)", () => {
  it("Upper Body A (bench + OHP): planned barbell/rack/flat bench, then the curated substitutes' dumbbells + adjustable bench", () => {
    expect(computeEquipmentAdaptationOptions(["bench-press", "overhead-press"])).toEqual([
      { equipmentId: "barbell", displayLabel: "Barbell (with plates)", relevance: "PLANNED" },
      { equipmentId: "barbell-rack", displayLabel: "Barbell rack / uprights", relevance: "PLANNED" },
      { equipmentId: "flat-bench", displayLabel: "Flat bench", relevance: "PLANNED" },
      { equipmentId: "adjustable-bench", displayLabel: "Adjustable (incline) bench", relevance: "SUBSTITUTE" },
      { equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "SUBSTITUTE" },
    ]);
  });

  it("an id required by both a planned exercise and a substitute is listed once, as PLANNED", () => {
    const options = computeEquipmentAdaptationOptions(["bench-press", "dumbbell-bench-press"]);
    expect(options.filter((o) => o.equipmentId === "dumbbells")).toEqual([{ equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "PLANNED" }]);
    expect(new Set(options.map((o) => o.equipmentId)).size).toBe(options.length);
  });

  it("is order-independent over exercises and deterministic", () => {
    expect(computeEquipmentAdaptationOptions(["overhead-press", "bench-press", "bench-press"])).toEqual(computeEquipmentAdaptationOptions(["bench-press", "overhead-press"]));
  });

  it("null / unknown identities and an empty workout contribute nothing", () => {
    expect(computeEquipmentAdaptationOptions([null, "not-in-catalog"])).toEqual([]);
    expect(computeEquipmentAdaptationOptions([])).toEqual([]);
  });

  it("every option is a canonical catalog equipment definition", () => {
    for (const option of computeEquipmentAdaptationOptions(["bench-press", "barbell-row", "lat-pulldown", "back-squat", "deadlift"])) {
      expect(exerciseEquipmentCatalogV1.getEquipmentDefinition(option.equipmentId)?.displayLabel).toBe(option.displayLabel);
    }
  });
});
