import { describe, expect, it } from "vitest";
import type { ExternalWeightLoad, RepTargetV1 } from "@vostivo/domain";
import { formatEngineVersion } from "../engine-version.js";
import { evaluateProgression, progressionPolicyV1 } from "./policy.js";
import type { ProgressionEvaluationInput, ProgressionExposureV1 } from "./input.js";

/**
 * CC-01 Strength Regression Baseline — golden outputs of the pure engine.
 * `policy.test.ts` proves the method; this pins the frozen version and the
 * decision for canonical situations, so an unversioned behavior change fails
 * here. Changing an entry requires a policy version bump, never just an edit.
 */
const SET_IDS = ["set-1", "set-2", "set-3"] as const;
const RANGE_8_12: RepTargetV1 = { kind: "RANGE", minReps: 8, maxReps: 12 };
const LOAD: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };

function exposure(reps: readonly number[]): ProgressionExposureV1 {
  return {
    comparability: "COMPARABLE",
    exerciseRef: "bench-press",
    workingSets: reps.map((actualReps, index) => ({
      prescriptionSetId: SET_IDS[index] ?? null,
      setType: "WORKING",
      actualReps,
    })),
  };
}

function input(exposures: readonly ProgressionExposureV1[]): ProgressionEvaluationInput {
  return {
    prescription: {
      exerciseRef: "bench-press",
      prescriptionExerciseId: "presc-ex-1",
      targetReps: RANGE_8_12,
      targetLoad: LOAD,
      prescribedWorkingSetIds: [...SET_IDS],
    },
    exposures,
  };
}

describe("CC-01 progression golden baseline", () => {
  it("CC01-PROG-001: the engine identity stays frozen", () => {
    expect(formatEngineVersion(progressionPolicyV1.version)).toBe("progression@v1");
  });

  it.each<[string, readonly ProgressionExposureV1[]]>([
    ["no evidence", []],
    ["single exposure at the top of the range", [exposure([12, 12, 12])]],
    ["two exposures at the top of the range", [exposure([12, 12, 12]), exposure([11, 11, 11])]],
    ["reps improving inside the range", [exposure([10, 10, 9]), exposure([9, 9, 9])]],
    ["flat performance", [exposure([9, 9, 9]), exposure([9, 9, 9]), exposure([9, 9, 9])]],
    ["one exposure regressed below the floor", [exposure([7, 7, 6]), exposure([10, 10, 10])]],
    ["partial exposure", [exposure([12, 12]), exposure([11, 11, 11])]],
  ])("CC01-PROG-002: golden decision — %s", (_name, exposures) => {
    const result = evaluateProgression(input(exposures));
    if (!result.ok) throw new Error(`expected valid input, got ${JSON.stringify(result.error)}`);

    const { decisionType, reasonCode, evidenceStrength } = result.value.data;
    expect({ decisionType, reasonCode, evidenceStrength }).toMatchSnapshot();
  });
});
