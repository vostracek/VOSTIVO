import { describe, expect, it } from "vitest";
import {
  PROGRESSION_DECISION_TYPE_VALUES,
  PROGRESSION_EVIDENCE_STRENGTH_VALUES,
  PROGRESSION_REASON_CODE_VALUES,
} from "@vostivo/database";
import {
  EVIDENCE_STRENGTHS_V1,
  PROGRESSION_DECISION_TYPES_V1,
  REASON_CODES_V1,
} from "@vostivo/training-engine";

/**
 * `packages/database` duplicates these vocabularies as plain local arrays
 * rather than importing `@vostivo/training-engine` (that package
 * intentionally does not depend on it — docs/architecture/FOUNDATION.md).
 * `apps/api` is the one layer allowed to depend on both, so this is where
 * the two copies are locked in sync — a silent drift here (e.g. the
 * engine gaining a new reason code the DB enum doesn't know about) would
 * be a real, easy-to-miss bug.
 */
describe("progression_decisions DB vocabulary matches the real engine vocabulary", () => {
  it("decision types", () => {
    expect(PROGRESSION_DECISION_TYPE_VALUES).toEqual(PROGRESSION_DECISION_TYPES_V1);
  });

  it("evidence strengths", () => {
    expect(PROGRESSION_EVIDENCE_STRENGTH_VALUES).toEqual(EVIDENCE_STRENGTHS_V1);
  });

  it("reason codes", () => {
    expect(PROGRESSION_REASON_CODE_VALUES).toEqual(REASON_CODES_V1);
  });
});
