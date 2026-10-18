import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
  type EquipmentAdaptationNotApplicableErrorV1,
  type EquipmentAdaptationPreviewReplacementV1,
  type EquipmentAdaptationPreviewRequestV1,
  type EquipmentAdaptationPreviewResponseV1,
  type EquipmentAdaptationPreviewReviewReasonV1,
} from "./index.js";

describe("equipment adaptation preview contract (Slice B)", () => {
  it("canonical version strings", () => {
    expect(EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1).toBe("equipment-adaptation-preview/v1");
    expectTypeOf<EquipmentAdaptationPreviewResponseV1["policyVersion"]>().toEqualTypeOf<"equipment-adaptation/v1">();
  });

  it("the request carries ONLY target identity, catalog version and the complete session inventory", () => {
    expectTypeOf<keyof EquipmentAdaptationPreviewRequestV1>().toEqualTypeOf<"plannedWorkoutId" | "catalogVersion" | "availableEquipmentIds">();
  });

  it("the response is a discriminated union over NO_CHANGE / ADJUST_SESSION / REVIEW_REQUIRED with stable reasons", () => {
    expectTypeOf<EquipmentAdaptationPreviewResponseV1["result"]>().toEqualTypeOf<"NO_CHANGE" | "ADJUST_SESSION" | "REVIEW_REQUIRED">();
    expectTypeOf<EquipmentAdaptationPreviewReviewReasonV1>().toEqualTypeOf<
      | "UNSUPPORTED_EXERCISE_IDENTITY"
      | "LOCKED_EXERCISE_UNAVAILABLE"
      | "NO_CURATED_SUBSTITUTE"
      | "NO_AVAILABLE_SUBSTITUTE"
      | "NO_EQUIVALENT_SUBSTITUTE"
      | "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY"
      | "SUBSTITUTE_CONFLICT"
      | "AMBIGUOUS_SUBSTITUTION"
    >();
    expectTypeOf<EquipmentAdaptationNotApplicableErrorV1["message"]>().toEqualTypeOf<"EQUIPMENT_ADAPTATION_NOT_APPLICABLE">();
  });

  it("a replacement has no load / conversion fields and no client-candidate tier/priority fields", () => {
    type Keys = keyof EquipmentAdaptationPreviewReplacementV1 | keyof EquipmentAdaptationPreviewReplacementV1["prescription"] | keyof EquipmentAdaptationPreviewReplacementV1["prescription"]["sets"][number];
    expectTypeOf<Extract<Keys, "targetLoad" | "load" | "loadConversion" | "compatibilityTier" | "substitutionPriority">>().toEqualTypeOf<never>();
  });
});
