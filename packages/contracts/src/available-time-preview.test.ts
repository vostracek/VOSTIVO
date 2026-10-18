import { describe, expect, it } from "vitest";
import { availableTimeApplicationFromPreview, type AvailableTimePreviewResponseV1 } from "./available-time-preview.js";

function id(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

/** The 8-minute fixture preview: OHP loses its last set. */
function preview(overrides: Partial<AvailableTimePreviewResponseV1> = {}): AvailableTimePreviewResponseV1 {
  return {
    policyVersion: "available-time/v1",
    plannedWorkoutId: id(1),
    sourceProgramVersionId: id(2),
    availableMinutes: 8,
    result: "ADJUST_SESSION",
    fitsAvailableTime: true,
    originalEstimatedSeconds: 540,
    adjustedEstimatedSeconds: 420,
    minimumEstimatedSeconds: null,
    previewFingerprint: "b".repeat(64),
    exercises: [
      { plannedExerciseId: id(10), exerciseRef: "bench-press", displayName: "Bench Press", priorityTier: "TIER_1", originalWorkingSetCount: 3, retainedWorkingSetCount: 3, removedWorkingSetCount: 0, originalTotalSetCount: 3, retainedTotalSetCount: 3, minimumWorkingSets: 2, removedEntireExercise: false, retainedPlannedSetIds: [id(101), id(102), id(103)], removedPlannedSetIds: [] },
      { plannedExerciseId: id(20), exerciseRef: "overhead-press", displayName: "Overhead Press", priorityTier: "TIER_2", originalWorkingSetCount: 2, retainedWorkingSetCount: 1, removedWorkingSetCount: 1, originalTotalSetCount: 2, retainedTotalSetCount: 1, minimumWorkingSets: 0, removedEntireExercise: false, retainedPlannedSetIds: [id(201)], removedPlannedSetIds: [id(202)] },
    ],
    ...overrides,
  };
}

describe("availableTimeApplicationFromPreview", () => {
  it("maps an ADJUST_SESSION preview to the exact TODAY_ONLY application (ids verbatim, no re-derivation)", () => {
    expect(availableTimeApplicationFromPreview(preview())).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        scope: "TODAY_ONLY",
        policyVersion: "available-time/v1",
        plannedWorkoutId: id(1),
        sourceProgramVersionId: id(2),
        availableMinutes: 8,
        previewFingerprint: "b".repeat(64),
        originalEstimatedSeconds: 540,
        adjustedEstimatedSeconds: 420,
        exercises: [
          { plannedExerciseId: id(10), retainedPlannedSetIds: [id(101), id(102), id(103)], removedPlannedSetIds: [] },
          { plannedExerciseId: id(20), retainedPlannedSetIds: [id(201)], removedPlannedSetIds: [id(202)] },
        ],
      },
    });
  });

  it.each(["NO_CHANGE", "CANNOT_FIT_MINIMUM"] as const)("refuses %s — never applicable through the adjusted path", (result) => {
    expect(availableTimeApplicationFromPreview(preview({ result }))).toEqual({ ok: false, error: { reason: "NOT_ADJUST_SESSION", result } });
  });

  it("refuses a preview whose counts disagree with its ids", () => {
    const [bench, ohp] = preview().exercises;
    const inconsistent = preview({ exercises: [bench!, { ...ohp!, retainedTotalSetCount: 2 }] });
    expect(availableTimeApplicationFromPreview(inconsistent)).toEqual({ ok: false, error: { reason: "COUNTS_DISAGREE_WITH_IDS", plannedExerciseId: id(20) } });
  });

  it("refuses a preview whose ids are not a valid partition", () => {
    const [bench, ohp] = preview().exercises;
    const overlapping = preview({ exercises: [bench!, { ...ohp!, retainedPlannedSetIds: [id(201)], removedPlannedSetIds: [id(201)] }] });
    expect(availableTimeApplicationFromPreview(overlapping)).toEqual({ ok: false, error: { reason: "INVALID_APPLICATION", detail: "DUPLICATE_SET" } });
  });
});
