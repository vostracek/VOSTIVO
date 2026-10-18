import { describe, expect, it } from "vitest";
import type { ExternalWeightLoad, RepTargetV1 } from "@vostivo/domain";
import { validateProgressionInput } from "./validate-input.js";
import type { ProgressionEvaluationInput, ProgressionExposureV1 } from "./input.js";

const RANGE_8_12: RepTargetV1 = { kind: "RANGE", minReps: 8, maxReps: 12 };
const LOAD_60KG: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };

const SAMPLE_EXPOSURE: ProgressionExposureV1 = {
  comparability: "COMPARABLE",
  exerciseRef: "bench-press",
  workingSets: [
    { prescriptionSetId: "set-1", setType: "WORKING", actualReps: 12 },
    { prescriptionSetId: "set-2", setType: "WORKING", actualReps: 12 },
    { prescriptionSetId: "set-3", setType: "WORKING", actualReps: 12 },
  ],
};

function validInput(): ProgressionEvaluationInput {
  return {
    prescription: {
      exerciseRef: "bench-press",
      prescriptionExerciseId: "presc-ex-1",
      targetReps: RANGE_8_12,
      targetLoad: LOAD_60KG,
      prescribedWorkingSetIds: ["set-1", "set-2", "set-3"],
    },
    exposures: [SAMPLE_EXPOSURE],
  };
}

describe("validateProgressionInput", () => {
  it("accepts a well-formed input", () => {
    expect(validateProgressionInput(validInput()).ok).toBe(true);
  });

  it("rejects zero prescribed working sets (§28)", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      prescription: { ...input.prescription, prescribedWorkingSetIds: [] },
    });
    expect(result).toEqual({ ok: false, error: { reason: "NO_PRESCRIBED_WORKING_SETS" } });
  });

  it("rejects an invalid RANGE (min > max)", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      prescription: { ...input.prescription, targetReps: { kind: "RANGE", minReps: 12, maxReps: 8 } },
    });
    expect(result).toEqual({ ok: false, error: { reason: "INVALID_REP_TARGET" } });
  });

  it("rejects a non-positive EXACT rep target", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      prescription: { ...input.prescription, targetReps: { kind: "EXACT", reps: 0 } },
    });
    expect(result).toEqual({ ok: false, error: { reason: "INVALID_REP_TARGET" } });
  });

  it("rejects a non-integer, non-positive, or overflowing external load", () => {
    const input = validInput();
    const badLoads: ExternalWeightLoad[] = [
      { kind: "EXTERNAL_WEIGHT", amountMilli: 0, unit: "KG", basis: "TOTAL" },
      { kind: "EXTERNAL_WEIGHT", amountMilli: 40.5, unit: "KG", basis: "TOTAL" },
      { kind: "EXTERNAL_WEIGHT", amountMilli: -1000, unit: "KG", basis: "TOTAL" },
    ];
    for (const targetLoad of badLoads) {
      const result = validateProgressionInput({ ...input, prescription: { ...input.prescription, targetLoad } });
      expect(result).toEqual({ ok: false, error: { reason: "INVALID_EXTERNAL_LOAD" } });
    }
  });

  it("rejects an evidence window longer than 3 exposures (§11's bounded window)", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      exposures: [SAMPLE_EXPOSURE, SAMPLE_EXPOSURE, SAMPLE_EXPOSURE, SAMPLE_EXPOSURE],
    });
    expect(result).toEqual({ ok: false, error: { reason: "EVIDENCE_WINDOW_EXCEEDED" } });
  });

  it("rejects a duplicate prescriptionSetId within one exposure", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      exposures: [
        {
          comparability: "COMPARABLE",
          exerciseRef: "bench-press",
          workingSets: [
            { prescriptionSetId: "set-1", setType: "WORKING", actualReps: 12 },
            { prescriptionSetId: "set-1", setType: "WORKING", actualReps: 10 },
          ],
        },
      ],
    });
    expect(result).toEqual({ ok: false, error: { reason: "DUPLICATE_PRESCRIPTION_SET_ID", exposureIndex: 0 } });
  });

  it("rejects a different exerciseRef inside one evaluation (§28 — never fuzzy-trusted)", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      exposures: [{ ...SAMPLE_EXPOSURE, exerciseRef: "incline-dumbbell-press" }],
    });
    expect(result).toEqual({ ok: false, error: { reason: "EXERCISE_REF_MISMATCH", exposureIndex: 0 } });
  });

  it("rejects unexpected WARM_UP evidence rather than silently dropping it (§5.6/§28)", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      exposures: [
        {
          comparability: "COMPARABLE",
          exerciseRef: "bench-press",
          workingSets: [
            { prescriptionSetId: "set-1", setType: "WARM_UP", actualReps: 10 },
            { prescriptionSetId: "set-2", setType: "WORKING", actualReps: 12 },
          ],
        },
      ],
    });
    expect(result).toEqual({ ok: false, error: { reason: "UNEXPECTED_WARM_UP_EVIDENCE", exposureIndex: 0 } });
  });

  it("rejects a negative or non-integer actualReps", () => {
    const input = validInput();
    for (const actualReps of [-1, 8.5]) {
      const result = validateProgressionInput({
        ...input,
        exposures: [
          {
            comparability: "COMPARABLE",
            exerciseRef: "bench-press",
            workingSets: [{ prescriptionSetId: "set-1", setType: "WORKING", actualReps }],
          },
        ],
      });
      expect(result).toEqual({ ok: false, error: { reason: "INVALID_WORKING_SET_DATA", exposureIndex: 0 } });
    }
  });

  it("accepts an unplanned extra set (null prescriptionSetId) without treating it as a duplicate", () => {
    const input = validInput();
    const result = validateProgressionInput({
      ...input,
      exposures: [
        {
          comparability: "COMPARABLE",
          exerciseRef: "bench-press",
          workingSets: [
            { prescriptionSetId: "set-1", setType: "WORKING", actualReps: 12 },
            { prescriptionSetId: null, setType: "WORKING", actualReps: 12 },
            { prescriptionSetId: null, setType: "WORKING", actualReps: 10 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});
