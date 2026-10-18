import { describe, expect, it } from "vitest";
import { availableTimeApplicationFromPreview } from "@vostivo/contracts";
import { selectAvailableTimePrescription, type AvailableTimeApplicationV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { computeAvailableTimePreview, type AvailableTimeExerciseRow } from "../plan/available-time-preview.js";
import type { StartProvenance } from "../plan/planned-provenance.js";
import { decideAvailableTimeStart } from "./available-time-start.js";

/**
 * The pure Available-Time START decision (closure patch §1). Real-Postgres
 * coverage of the same rules lives in available-time-start.integration.test.ts;
 * this file additionally reaches the one case immutable ProgramVersions make
 * impossible to produce naturally: an owned source that can no longer be
 * evaluated (SOURCE_NOT_EVALUABLE -> UNVERIFIED).
 */
function id(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

const WORKOUT = id(1);
const VERSION = id(2);

function rows(): AvailableTimeExerciseRow[] {
  const sets = (exercise: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: id(exercise * 10 + i + 1), orderIndex: i + 1, setType: "WORKING" as const, restSeconds: 90 }));
  return [
    { id: id(10), exerciseRef: "bench-press", displayName: "Bench Press", orderIndex: 1, priorityTier: "TIER_1", minimumWorkingSets: 2, sets: sets(10, 3) },
    { id: id(20), exerciseRef: "overhead-press", displayName: "Overhead Press", orderIndex: 2, priorityTier: "TIER_2", minimumWorkingSets: 0, sets: sets(20, 2) },
  ];
}

function provenance(status: "ACTIVE" | "SUPERSEDED" = "ACTIVE", exercises = rows()): StartProvenance {
  return { kind: "PLANNED", source: { plannedWorkoutId: WORKOUT, programVersionId: VERSION, programVersionStatus: status, programStatus: "ACTIVE" }, exercises };
}

function fullPrescription(): WorkoutPrescriptionV1 {
  return {
    schemaVersion: 1,
    prescriptionId: WORKOUT,
    name: "Upper Body A",
    exercises: rows().map((exercise) => ({
      prescriptionExerciseId: exercise.id,
      exerciseRef: exercise.exerciseRef,
      displayName: exercise.displayName,
      order: exercise.orderIndex,
      sets: exercise.sets.map((set) => ({ prescriptionSetId: set.id, order: set.orderIndex, targetReps: null, targetLoad: null, restSeconds: set.restSeconds, setType: set.setType })),
    })),
  };
}

/** The genuine 8-minute adjustment, exactly as the client builds it. */
function genuine(): { application: AvailableTimeApplicationV1; snapshot: WorkoutPrescriptionV1 } {
  const preview = computeAvailableTimePreview({ plannedWorkoutId: WORKOUT, programVersionId: VERSION, availableMinutes: 8, exercises: rows() });
  if (!preview.ok) throw new Error(preview.error.code);
  const application = availableTimeApplicationFromPreview(preview.value);
  if (!application.ok) throw new Error(application.error.reason);
  const snapshot = selectAvailableTimePrescription(fullPrescription(), application.value);
  if (!snapshot.ok) throw new Error(snapshot.error);
  return { application: application.value, snapshot: snapshot.value };
}

describe("decideAvailableTimeStart", () => {
  it("1: a fresh exact re-derivation from the current source -> VERIFIED", () => {
    const { application, snapshot } = genuine();
    expect(decideAvailableTimeStart(application, provenance(), snapshot)).toEqual({ accepted: true, verification: { status: "VERIFIED", reason: null } });
  });

  it("2: exact re-derivation, source no longer current -> STALE (accepted)", () => {
    const { application, snapshot } = genuine();
    expect(decideAvailableTimeStart(application, provenance("SUPERSEDED"), snapshot)).toEqual({ accepted: true, verification: { status: "STALE", reason: "SOURCE_NOT_CURRENT" } });
  });

  it("8: an owned, intact source that genuinely cannot be re-evaluated -> UNVERIFIED (accepted)", () => {
    // The authored tier is gone from the (owned) source, so available-time/v1 cannot run
    // at all: nothing about the client payload can be proven wrong.
    const { application, snapshot } = genuine();
    const unevaluable = rows().map((exercise, index) => (index === 1 ? { ...exercise, priorityTier: null } : exercise));
    expect(decideAvailableTimeStart(application, provenance("ACTIVE", unevaluable), snapshot)).toEqual({ accepted: true, verification: { status: "UNVERIFIED", reason: "SOURCE_NOT_EVALUABLE" } });
  });

  it.each([
    ["FINGERPRINT_MISMATCH", (a: AvailableTimeApplicationV1) => ({ ...a, previewFingerprint: "0".repeat(64) })],
    ["DURATION_MISMATCH", (a: AvailableTimeApplicationV1) => ({ ...a, adjustedEstimatedSeconds: a.adjustedEstimatedSeconds - 1 })],
    ["DURATION_MISMATCH", (a: AvailableTimeApplicationV1) => ({ ...a, originalEstimatedSeconds: a.originalEstimatedSeconds + 1 })],
    ["SOURCE_VERSION_MISMATCH", (a: AvailableTimeApplicationV1) => ({ ...a, sourceProgramVersionId: id(3) })],
    ["FOREIGN_EXERCISE", (a: AvailableTimeApplicationV1) => ({ ...a, exercises: [a.exercises[0]!, { ...a.exercises[1]!, plannedExerciseId: id(99) }] })],
    ["FOREIGN_SET", (a: AvailableTimeApplicationV1) => ({ ...a, exercises: [a.exercises[0]!, { ...a.exercises[1]!, removedPlannedSetIds: [id(999)] }] })],
  ])("9: a proven contradiction is REJECTED (%s), never UNVERIFIED", (reason, tamper) => {
    const { application, snapshot } = genuine();
    expect(decideAvailableTimeStart(tamper(application), provenance(), snapshot)).toEqual({ accepted: false, reason });
  });

  it("9: an exact-diff mismatch with a genuine fingerprint is REJECTED (DIFF_MISMATCH)", () => {
    const { application } = genuine();
    const tampered: AvailableTimeApplicationV1 = {
      ...application,
      exercises: [
        { plannedExerciseId: id(10), retainedPlannedSetIds: [id(101), id(102)], removedPlannedSetIds: [id(103)] },
        { plannedExerciseId: id(20), retainedPlannedSetIds: [id(201), id(202)], removedPlannedSetIds: [] },
      ],
    };
    const snapshot = selectAvailableTimePrescription(fullPrescription(), tampered);
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(decideAvailableTimeStart(tampered, provenance(), snapshot.value)).toEqual({ accepted: false, reason: "DIFF_MISMATCH" });
  });

  it("9: a result-kind mismatch is REJECTED (RESULT_MISMATCH) — 9 min is NO_CHANGE", () => {
    const { application, snapshot } = genuine();
    const noChange = computeAvailableTimePreview({ plannedWorkoutId: WORKOUT, programVersionId: VERSION, availableMinutes: 9, exercises: rows() });
    if (!noChange.ok) throw new Error(noChange.error.code);
    const claimed = { ...application, availableMinutes: 9, previewFingerprint: noChange.value.previewFingerprint };
    expect(decideAvailableTimeStart(claimed, provenance(), snapshot)).toEqual({ accepted: false, reason: "RESULT_MISMATCH" });
  });

  it("the snapshot must be exactly the retained structure (SNAPSHOT_MISMATCH), and the source must be a PLANNED owned workout", () => {
    const { application } = genuine();
    expect(decideAvailableTimeStart(application, provenance(), fullPrescription())).toEqual({ accepted: false, reason: "SNAPSHOT_MISMATCH" });
    expect(decideAvailableTimeStart(application, { kind: "UNPLANNED" }, genuine().snapshot)).toEqual({ accepted: false, reason: "SOURCE_NOT_PLANNED" });
  });
});
