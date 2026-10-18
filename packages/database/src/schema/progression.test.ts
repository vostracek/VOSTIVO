import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  PROGRESSION_DECISION_TYPE_VALUES,
  PROGRESSION_EVIDENCE_STRENGTH_VALUES,
  PROGRESSION_REASON_CODE_VALUES,
  progressionDecisions,
} from "./progression.js";

/**
 * Schema-shape tests only — no live Postgres connection required (same
 * precedent as workout.test.ts/plan.test.ts). Cross-package vocabulary
 * consistency against the real `packages/training-engine` engine is
 * locked separately in apps/api (see
 * `progression-evaluation.service.test.ts`) — packages/database
 * intentionally does not depend on packages/training-engine.
 */
describe("progression schema", () => {
  it("defines progression_decisions in the app schema", () => {
    expect(getTableName(progressionDecisions)).toBe("progression_decisions");
  });

  it("locks the decision vocabulary to exactly NO_CHANGE / MAINTAIN_LOAD_BUILD_REPS / INCREASE_LOAD", () => {
    expect(PROGRESSION_DECISION_TYPE_VALUES).toEqual([
      "NO_CHANGE",
      "MAINTAIN_LOAD_BUILD_REPS",
      "INCREASE_LOAD",
    ]);
  });

  it("locks evidence strength to a deterministic categorical vocabulary, never a numeric score", () => {
    expect(PROGRESSION_EVIDENCE_STRENGTH_VALUES).toEqual([
      "INSUFFICIENT",
      "SINGLE_EXPOSURE",
      "SUPPORTED",
      "STRONG",
    ]);
  });

  it("locks the finite reason-code vocabulary", () => {
    expect(PROGRESSION_REASON_CODE_VALUES).toHaveLength(10);
    expect(PROGRESSION_REASON_CODE_VALUES).toContain("TOP_OF_RANGE_ACHIEVED");
    expect(PROGRESSION_REASON_CODE_VALUES).toContain("NO_SUITABLE_LOAD_INCREMENT");
  });

  it("ownership is userId only — no athleteProfileId column duplicating WDI ownership", () => {
    expect(Object.keys(progressionDecisions)).toContain("userId");
    expect(Object.keys(progressionDecisions)).not.toContain("athleteProfileId");
  });

  it("carries both the normalized input snapshot and evidence refs for audit reproducibility", () => {
    expect(Object.keys(progressionDecisions)).toEqual(
      expect.arrayContaining(["normalizedInputSnapshot", "evidenceRefs", "evidenceFingerprint"]),
    );
  });

  it("appliedAt and supersededByDecisionId are nullable — no application mechanism exists yet", () => {
    expect(progressionDecisions.appliedAt.notNull).toBe(false);
    expect(progressionDecisions.supersededByDecisionId.notNull).toBe(false);
  });

  it("engine/policy version is persisted as queryable text, not inferred from current code", () => {
    expect(Object.keys(progressionDecisions)).toEqual(expect.arrayContaining(["engine", "policy"]));
  });
});
