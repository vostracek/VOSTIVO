import { describe, expect, it } from "vitest";
import { normalizeStoredPrescription } from "./prescription-compat.js";

/**
 * Regression coverage for the real bug found during Progression
 * Prerequisites V1 native verification (see prescription-compat.ts's
 * doc comment) — a stored prescription snapshot from before `setType`
 * existed must still load without crashing `completeSet()`.
 */
function rawPrescriptionMissingSetType(): unknown {
  return {
    schemaVersion: 1,
    prescriptionId: "presc-1",
    name: "Old Session (pre-setType)",
    exercises: [
      {
        prescriptionExerciseId: "ex-1",
        exerciseRef: "bench-press",
        displayName: "Bench Press",
        order: 0,
        sets: [
          // Exactly what a real pre-existing local_workout_sessions row's
          // prescription_json looks like — no setType key at all.
          { prescriptionSetId: "set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: null, restSeconds: 90 },
        ],
      },
    ],
  };
}

describe("normalizeStoredPrescription — Progression Prerequisites V1 backward compatibility", () => {
  it("PROG-PREREQ-COMPAT-001: a set with no setType at all defaults to WORKING, never undefined", () => {
    const normalized = normalizeStoredPrescription(rawPrescriptionMissingSetType());
    expect(normalized.exercises[0]?.sets[0]?.setType).toBe("WORKING");
  });

  it("PROG-PREREQ-COMPAT-002: an already-correct setType is preserved unchanged", () => {
    const raw = rawPrescriptionMissingSetType() as { exercises: { sets: { setType?: string }[] }[] };
    raw.exercises[0]!.sets[0]!.setType = "WARM_UP";

    const normalized = normalizeStoredPrescription(raw);
    expect(normalized.exercises[0]?.sets[0]?.setType).toBe("WARM_UP");
  });

  it("PROG-PREREQ-COMPAT-003: every other field is carried through unchanged", () => {
    const normalized = normalizeStoredPrescription(rawPrescriptionMissingSetType());
    expect(normalized.prescriptionId).toBe("presc-1");
    expect(normalized.exercises[0]?.exerciseRef).toBe("bench-press");
    expect(normalized.exercises[0]?.sets[0]?.targetReps).toEqual({ kind: "RANGE", minReps: 8, maxReps: 12 });
  });

  it("PROG-PREREQ-COMPAT-004: multiple exercises/sets are all normalized", () => {
    const raw = {
      schemaVersion: 1,
      prescriptionId: "presc-2",
      name: "Multi",
      exercises: [
        { prescriptionExerciseId: "ex-1", exerciseRef: null, displayName: "A", order: 0, sets: [{ prescriptionSetId: "s1", order: 0, targetReps: null, targetLoad: null, restSeconds: null }] },
        { prescriptionExerciseId: "ex-2", exerciseRef: null, displayName: "B", order: 1, sets: [{ prescriptionSetId: "s2", order: 0, targetReps: null, targetLoad: null, restSeconds: null }, { prescriptionSetId: "s3", order: 1, targetReps: null, targetLoad: null, restSeconds: null }] },
      ],
    };

    const normalized = normalizeStoredPrescription(raw);
    expect(normalized.exercises[0]?.sets[0]?.setType).toBe("WORKING");
    expect(normalized.exercises[1]?.sets[0]?.setType).toBe("WORKING");
    expect(normalized.exercises[1]?.sets[1]?.setType).toBe("WORKING");
  });
});
