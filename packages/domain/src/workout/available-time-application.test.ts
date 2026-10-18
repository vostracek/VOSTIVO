import { describe, expect, it } from "vitest";
import {
  selectAvailableTimePrescription,
  validateAvailableTimeApplication,
  verifyAvailableTimeSnapshot,
  type AvailableTimeApplicationV1,
} from "./available-time-application.js";
import type { PrescribedSetV1, WorkoutPrescriptionV1 } from "./prescription.js";

/** Deterministic UUID-shaped ids: `id(1)` -> 00000000-0000-7000-8000-000000000001. */
function id(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

const WORKOUT = id(1);
const VERSION = id(2);
const BENCH = id(10);
const OHP = id(20);
const BENCH_WARM_UP = id(100);
const [BENCH_S1, BENCH_S2, BENCH_S3] = [id(101), id(102), id(103)];
const [OHP_S1, OHP_S2] = [id(201), id(202)];

function set(prescriptionSetId: string, order: number, overrides: Partial<PrescribedSetV1> = {}): PrescribedSetV1 {
  return {
    prescriptionSetId,
    order,
    targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
    targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
    restSeconds: 90,
    setType: "WORKING",
    ...overrides,
  };
}

/** Bench: warm-up + 3 working (progressed to 62.5kg), OHP: 2 working. Rows deliberately out of order. */
function prescription(): WorkoutPrescriptionV1 {
  const progressed = { kind: "EXTERNAL_WEIGHT", amountMilli: 62500, unit: "KG", basis: "TOTAL" } as const;
  return {
    schemaVersion: 1,
    prescriptionId: WORKOUT,
    name: "Upper Body A",
    exercises: [
      { prescriptionExerciseId: OHP, exerciseRef: "overhead-press", displayName: "Overhead Press", order: 2, sets: [set(OHP_S2, 2), set(OHP_S1, 1)] },
      {
        prescriptionExerciseId: BENCH,
        exerciseRef: "bench-press",
        displayName: "Bench Press",
        order: 1,
        sets: [
          set(BENCH_S2, 2, { targetLoad: progressed }),
          set(BENCH_WARM_UP, 0, { setType: "WARM_UP", targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 40000, unit: "KG", basis: "TOTAL" } }),
          set(BENCH_S1, 1, { targetLoad: progressed }),
          set(BENCH_S3, 3, { targetLoad: progressed }),
        ],
      },
    ],
  };
}

/** The 5-minute-style ADJUST: OHP removed entirely, Bench keeps warm-up + 2 working. */
function application(overrides: Partial<AvailableTimeApplicationV1> = {}): AvailableTimeApplicationV1 {
  return {
    schemaVersion: 1,
    scope: "TODAY_ONLY",
    policyVersion: "available-time/v1",
    plannedWorkoutId: WORKOUT,
    sourceProgramVersionId: VERSION,
    availableMinutes: 5,
    previewFingerprint: "a".repeat(64),
    originalEstimatedSeconds: 630,
    adjustedEstimatedSeconds: 300,
    exercises: [
      { plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1, BENCH_S2], removedPlannedSetIds: [BENCH_S3] },
      { plannedExerciseId: OHP, retainedPlannedSetIds: [], removedPlannedSetIds: [OHP_S1, OHP_S2] },
    ],
    ...overrides,
  };
}

describe("validateAvailableTimeApplication — untrusted structure", () => {
  it("accepts a well-formed ADJUST application", () => {
    expect(validateAvailableTimeApplication(application())).toEqual({ ok: true, value: application() });
  });

  it.each([
    ["INVALID_SHAPE", null],
    ["INVALID_SHAPE", { ...application(), exercises: "nope" }],
    ["UNSUPPORTED_SCHEMA_VERSION", { ...application(), schemaVersion: 2 }],
    ["UNSUPPORTED_SCOPE", { ...application(), scope: "PERMANENT" }],
    ["UNSUPPORTED_POLICY_VERSION", { ...application(), policyVersion: "available-time/v2" }],
    ["INVALID_IDENTIFIER", { ...application(), plannedWorkoutId: "workout-1" }],
    ["INVALID_IDENTIFIER", { ...application(), exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: ["'; drop table"], removedPlannedSetIds: [BENCH_S3] }] }],
    ["INVALID_AVAILABLE_MINUTES", { ...application(), availableMinutes: 0 }],
    ["INVALID_AVAILABLE_MINUTES", { ...application(), availableMinutes: 241 }],
    ["INVALID_AVAILABLE_MINUTES", { ...application(), availableMinutes: 5.5 }],
    ["INVALID_FINGERPRINT", { ...application(), previewFingerprint: "xyz" }],
    ["INVALID_DURATION", { ...application(), adjustedEstimatedSeconds: 630 }],
    ["INVALID_DURATION", { ...application(), adjustedEstimatedSeconds: 301 }],
    ["DUPLICATE_EXERCISE", { ...application(), exercises: [application().exercises[0], application().exercises[0]] }],
    ["DUPLICATE_SET", { ...application(), exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_S1], removedPlannedSetIds: [BENCH_S1] }] }],
    ["DUPLICATE_SET", { ...application(), exercises: [application().exercises[0], { plannedExerciseId: OHP, retainedPlannedSetIds: [], removedPlannedSetIds: [BENCH_S3] }] }],
    ["EXERCISE_WITHOUT_SETS", { ...application(), exercises: [...application().exercises, { plannedExerciseId: id(30), retainedPlannedSetIds: [], removedPlannedSetIds: [] }] }],
    ["NO_RETAINED_SET", { ...application(), exercises: [{ plannedExerciseId: OHP, retainedPlannedSetIds: [], removedPlannedSetIds: [OHP_S1, OHP_S2] }] }],
    ["NOTHING_REMOVED", { ...application(), exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_S1], removedPlannedSetIds: [] }] }],
  ])("rejects %s", (reason, value) => {
    expect(validateAvailableTimeApplication(value)).toEqual({ ok: false, error: reason });
  });
});

describe("selectAvailableTimePrescription — the one structural filter", () => {
  it("keeps exactly the retained sets, in canonical order, and drops a fully removed exercise", () => {
    const result = selectAvailableTimePrescription(prescription(), application());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exercises.map((e) => e.prescriptionExerciseId)).toEqual([BENCH]);
    expect(result.value.exercises[0]!.sets.map((s) => s.prescriptionSetId)).toEqual([BENCH_WARM_UP, BENCH_S1, BENCH_S2]);
  });

  it("preserves warm-ups and every retained set's effective (progressed) load/reps/rest/type verbatim", () => {
    const source = prescription();
    const result = selectAvailableTimePrescription(source, application());
    if (!result.ok) throw new Error("expected ok");
    const sourceBench = source.exercises.find((e) => e.prescriptionExerciseId === BENCH)!;
    for (const retained of result.value.exercises[0]!.sets) {
      expect(retained).toBe(sourceBench.sets.find((s) => s.prescriptionSetId === retained.prescriptionSetId));
    }
    expect(result.value.exercises[0]!.sets[0]).toMatchObject({ setType: "WARM_UP", targetLoad: { amountMilli: 40000 } });
    expect(result.value.exercises[0]!.sets[1]).toMatchObject({ setType: "WORKING", targetLoad: { amountMilli: 62500 } });
    expect(result.value).toMatchObject({ schemaVersion: 1, prescriptionId: WORKOUT, name: "Upper Body A" });
  });

  it("never mutates the source prescription", () => {
    const source = prescription();
    const before = JSON.stringify(source);
    selectAvailableTimePrescription(source, application());
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps a partially reduced exercise and its canonical exercise order", () => {
    const partial = application({
      exercises: [
        { plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1, BENCH_S2, BENCH_S3], removedPlannedSetIds: [] },
        { plannedExerciseId: OHP, retainedPlannedSetIds: [OHP_S1], removedPlannedSetIds: [OHP_S2] },
      ],
    });
    const result = selectAvailableTimePrescription(prescription(), partial);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.exercises.map((e) => [e.prescriptionExerciseId, e.sets.map((s) => s.prescriptionSetId)])).toEqual([
      [BENCH, [BENCH_WARM_UP, BENCH_S1, BENCH_S2, BENCH_S3]],
      [OHP, [OHP_S1]],
    ]);
  });

  it.each([
    ["PRESCRIPTION_MISMATCH", application({ plannedWorkoutId: id(999) })],
    ["UNKNOWN_EXERCISE", application({ exercises: [...application().exercises, { plannedExerciseId: id(30), retainedPlannedSetIds: [], removedPlannedSetIds: [id(301)] }] })],
    ["EXERCISE_NOT_COVERED", application({ exercises: [application().exercises[0]!] })],
    ["PARTITION_MISMATCH", application({ exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1], removedPlannedSetIds: [BENCH_S3] }, application().exercises[1]!] })],
    ["PARTITION_MISMATCH", application({ exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1, BENCH_S2], removedPlannedSetIds: [id(999)] }, application().exercises[1]!] })],
    ["NON_CANONICAL_ORDER", application({ exercises: [{ plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_S1, BENCH_WARM_UP, BENCH_S2], removedPlannedSetIds: [BENCH_S3] }, application().exercises[1]!] })],
  ])("fails closed with %s", (reason, app) => {
    expect(selectAvailableTimePrescription(prescription(), app)).toEqual({ ok: false, error: reason });
  });
});

describe("verifyAvailableTimeSnapshot — server-side snapshot integrity", () => {
  function adjustedSnapshot(): WorkoutPrescriptionV1 {
    const result = selectAvailableTimePrescription(prescription(), application());
    if (!result.ok) throw new Error("expected ok");
    return result.value;
  }

  it("accepts exactly the retained structure", () => {
    expect(verifyAvailableTimeSnapshot(adjustedSnapshot(), application())).toEqual({ ok: true, value: true });
  });

  it("rejects the unadjusted full prescription (removed sets present)", () => {
    expect(verifyAvailableTimeSnapshot(prescription(), application())).toEqual({ ok: false, error: "PARTITION_MISMATCH" });
  });

  it("rejects a snapshot for a different planned workout", () => {
    expect(verifyAvailableTimeSnapshot({ ...adjustedSnapshot(), prescriptionId: id(999) }, application())).toEqual({ ok: false, error: "PRESCRIPTION_MISMATCH" });
  });

  it("rejects a snapshot carrying an extra or foreign set", () => {
    const snapshot = adjustedSnapshot();
    const tampered = { ...snapshot, exercises: [{ ...snapshot.exercises[0]!, sets: [...snapshot.exercises[0]!.sets, set(id(999), 9)] }] };
    expect(verifyAvailableTimeSnapshot(tampered, application())).toEqual({ ok: false, error: "PARTITION_MISMATCH" });
  });

  it("rejects a snapshot keeping a fully removed exercise", () => {
    const snapshot = adjustedSnapshot();
    const tampered = { ...snapshot, exercises: [...snapshot.exercises, { ...prescription().exercises[0]!, sets: [set(OHP_S1, 1)] }] };
    expect(verifyAvailableTimeSnapshot(tampered, application())).toEqual({ ok: false, error: "PARTITION_MISMATCH" });
  });

  it.each([
    ["a null exercise", [null]],
    ["an exercise without a sets array", [{ prescriptionExerciseId: BENCH, order: 1, sets: "x" }]],
    ["a set without an id", [{ prescriptionExerciseId: BENCH, order: 1, sets: [{ order: 1 }] }]],
  ])("rejects a hostile snapshot shape (%s) cleanly instead of throwing", (_label, exercises) => {
    const hostile = { ...adjustedSnapshot(), exercises } as unknown as WorkoutPrescriptionV1;
    expect(verifyAvailableTimeSnapshot(hostile, application())).toEqual({ ok: false, error: "PARTITION_MISMATCH" });
  });
});

