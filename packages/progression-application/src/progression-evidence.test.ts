import { describe, expect, it } from "vitest";
import type { WorkoutPrescriptionV1 } from "@vostivo/domain";
import { classifyComparability, reconstructPrescriptionContext } from "./progression-evidence.js";

function prescription(overrides: Partial<WorkoutPrescriptionV1["exercises"][number]> = {}): WorkoutPrescriptionV1 {
  return {
    schemaVersion: 1,
    prescriptionId: "presc-1",
    name: "Upper Body A",
    exercises: [
      {
        prescriptionExerciseId: "presc-ex-1",
        exerciseRef: "bench-press",
        displayName: "Bench Press",
        order: 0,
        sets: [
          {
            prescriptionSetId: "set-1",
            order: 0,
            targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
            targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
            restSeconds: null,
            setType: "WORKING",
          },
          {
            prescriptionSetId: "set-2",
            order: 1,
            targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
            targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
            restSeconds: null,
            setType: "WORKING",
          },
        ],
        ...overrides,
      },
    ],
  };
}

describe("reconstructPrescriptionContext", () => {
  it("reconstructs targetReps/targetLoad/prescribedWorkingSetIds from a matching prescriptionExerciseId", () => {
    const context = reconstructPrescriptionContext(prescription(), "presc-ex-1");
    expect(context).toEqual({
      targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
      targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
      prescribedWorkingSetIds: ["set-1", "set-2"],
    });
  });

  it("returns null for a null prescriptionExerciseId (unplanned/extra exercise, §10)", () => {
    expect(reconstructPrescriptionContext(prescription(), null)).toBeNull();
  });

  it("returns null when the prescriptionExerciseId has no match in the snapshot", () => {
    expect(reconstructPrescriptionContext(prescription(), "does-not-exist")).toBeNull();
  });

  it("returns null when the exercise has zero WORKING sets (only WARM_UP)", () => {
    const snapshot = prescription({
      sets: [
        {
          prescriptionSetId: "warmup-1",
          order: 0,
          targetReps: { kind: "EXACT", reps: 5 },
          targetLoad: null,
          restSeconds: null,
          setType: "WARM_UP",
        },
      ],
    });
    expect(reconstructPrescriptionContext(snapshot, "presc-ex-1")).toBeNull();
  });

  it("returns null when targetLoad is null (never fabricates a load)", () => {
    const snapshot = prescription({
      sets: [
        {
          prescriptionSetId: "set-1",
          order: 0,
          targetReps: { kind: "EXACT", reps: 10 },
          targetLoad: null,
          restSeconds: null,
          setType: "WORKING",
        },
      ],
    });
    expect(reconstructPrescriptionContext(snapshot, "presc-ex-1")).toBeNull();
  });

  it("returns null when prescribed WORKING sets have non-uniform targets (never averages/guesses)", () => {
    const snapshot = prescription({
      sets: [
        {
          prescriptionSetId: "set-1",
          order: 0,
          targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
          targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
          restSeconds: null,
          setType: "WORKING",
        },
        {
          prescriptionSetId: "set-2",
          order: 1,
          targetReps: { kind: "EXACT", reps: 5 },
          targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
          restSeconds: null,
          setType: "WORKING",
        },
      ],
    });
    expect(reconstructPrescriptionContext(snapshot, "presc-ex-1")).toBeNull();
  });
});

describe("classifyComparability", () => {
  const anchor = {
    exerciseOrder: 0,
    context: reconstructPrescriptionContext(prescription(), "presc-ex-1")!,
  };

  it("COMPARABLE: identical target, order, and working-set count", () => {
    const candidate = { exerciseOrder: 0, context: anchor.context, hasUnmatchedWorkingSet: false };
    expect(classifyComparability(anchor, candidate)).toBe("COMPARABLE");
  });

  it("NOT_COMPARABLE: different targetReps (a real prescription change, §12.11)", () => {
    const differentTarget = reconstructPrescriptionContext(
      prescription({
        sets: [
          {
            prescriptionSetId: "set-1",
            order: 0,
            targetReps: { kind: "EXACT", reps: 5 },
            targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
            restSeconds: null,
            setType: "WORKING",
          },
        ],
      }),
      "presc-ex-1",
    )!;
    const candidate = { exerciseOrder: 0, context: differentTarget, hasUnmatchedWorkingSet: false };
    expect(classifyComparability(anchor, candidate)).toBe("NOT_COMPARABLE");
  });

  it("NOT_COMPARABLE: different targetLoad unit (never auto-converted, §17)", () => {
    const differentUnit = {
      ...anchor.context,
      targetLoad: { kind: "EXTERNAL_WEIGHT" as const, amountMilli: 60000, unit: "LB" as const, basis: "TOTAL" as const },
    };
    const candidate = { exerciseOrder: 0, context: differentUnit, hasUnmatchedWorkingSet: false };
    expect(classifyComparability(anchor, candidate)).toBe("NOT_COMPARABLE");
  });

  it("COMPARABLE_WITH_CONTEXT: same target, changed exercise order (§10.2/§24)", () => {
    const candidate = { exerciseOrder: 2, context: anchor.context, hasUnmatchedWorkingSet: false };
    expect(classifyComparability(anchor, candidate)).toBe("COMPARABLE_WITH_CONTEXT");
  });

  it("COMPARABLE_WITH_CONTEXT: same target, different prescribed working-set count", () => {
    const fewerSets = { ...anchor.context, prescribedWorkingSetIds: ["set-1"] };
    const candidate = { exerciseOrder: 0, context: fewerSets, hasUnmatchedWorkingSet: false };
    expect(classifyComparability(anchor, candidate)).toBe("COMPARABLE_WITH_CONTEXT");
  });

  it("COMPARABLE_WITH_CONTEXT: same target, an unmatched/extra set present", () => {
    const candidate = { exerciseOrder: 0, context: anchor.context, hasUnmatchedWorkingSet: true };
    expect(classifyComparability(anchor, candidate)).toBe("COMPARABLE_WITH_CONTEXT");
  });
});
