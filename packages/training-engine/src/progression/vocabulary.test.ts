import { describe, expect, it } from "vitest";
import {
  COMPARABILITY_TIERS_V1,
  EVIDENCE_STRENGTHS_V1,
  PROGRESSION_DECISION_TYPES_V1,
  REASON_CODES_V1,
} from "./vocabulary.js";

describe("Pure Progression Engine V1 — locked vocabularies", () => {
  it("locks the decision vocabulary to exactly NO_CHANGE / MAINTAIN_LOAD_BUILD_REPS / INCREASE_LOAD (§13)", () => {
    expect(PROGRESSION_DECISION_TYPES_V1).toEqual(["NO_CHANGE", "MAINTAIN_LOAD_BUILD_REPS", "INCREASE_LOAD"]);
  });

  it("locks the comparability tiers the pure engine accepts to exactly the two assembly hands it (§10.1/§29)", () => {
    expect(COMPARABILITY_TIERS_V1).toEqual(["COMPARABLE", "COMPARABLE_WITH_CONTEXT"]);
  });

  it("locks evidence strength to a deterministic categorical vocabulary, never a numeric score (§17.3)", () => {
    expect(EVIDENCE_STRENGTHS_V1).toEqual(["INSUFFICIENT", "SINGLE_EXPOSURE", "SUPPORTED", "STRONG"]);
  });

  it("locks the finite reason-code vocabulary to §17.1's exact names", () => {
    expect(REASON_CODES_V1).toEqual([
      "TOP_OF_RANGE_ACHIEVED",
      "REPS_PROGRESSING",
      "PERFORMANCE_STABLE",
      "INSUFFICIENT_EVIDENCE",
      "SINGLE_EXPOSURE_ONLY",
      "PERFORMANCE_REGRESSED_SINGLE_EXPOSURE",
      "NON_COMPARABLE_CONTEXT",
      "PARTIAL_EXPOSURE",
      "PRESCRIPTION_CHANGED_RESET",
      "NO_SUITABLE_LOAD_INCREMENT",
    ]);
  });
});
