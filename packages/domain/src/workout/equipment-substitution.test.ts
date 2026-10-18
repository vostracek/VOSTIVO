import { describe, expect, it } from "vitest";
import { readSnapshotExerciseIdentities, snapshotDeclaresSubstitution } from "./equipment-substitution.js";
import type { PrescribedExerciseV1, WorkoutPrescriptionV1 } from "./prescription.js";

const APP = "01890a5d-ac96-774b-bcce-b302099a8057";

const substitution = (authoredExerciseRef: string, equipmentApplicationId = APP) => ({
  kind: "TEMPORARY_EQUIPMENT" as const,
  reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE" as const,
  authoredExerciseRef,
  authoredDisplayName: authoredExerciseRef,
  equipmentApplicationId,
  policyVersion: "equipment-adaptation/v1" as const,
  catalogVersion: "exercise-equipment-catalog/v1",
});

const exercise = (id: string, exerciseRef: string | null, extra: Partial<PrescribedExerciseV1> = {}): PrescribedExerciseV1 => ({ prescriptionExerciseId: id, exerciseRef, displayName: id, order: 1, sets: [], ...extra });

const snapshot = (exercises: unknown[]): WorkoutPrescriptionV1 => ({ schemaVersion: 1, prescriptionId: "w", name: "W", exercises: exercises as PrescribedExerciseV1[] });

describe("readSnapshotExerciseIdentities", () => {
  it("an ordinary snapshot -> every slot with its performed ref and no substitution", () => {
    expect(readSnapshotExerciseIdentities(snapshot([exercise("e1", "bench-press"), exercise("e2", null)]))).toEqual({
      ok: true,
      value: [
        { prescriptionExerciseId: "e1", exerciseRef: "bench-press", substitution: null },
        { prescriptionExerciseId: "e2", exerciseRef: null, substitution: null },
      ],
    });
  });

  it("reads performed (substitute) vs authored identity per slot, in snapshot order", () => {
    const result = readSnapshotExerciseIdentities(
      snapshot([exercise("e1", "dumbbell-bench-press", { substitution: substitution("bench-press") }), exercise("e2", "lat-pulldown"), exercise("e3", "seated-cable-row", { substitution: substitution("barbell-row", "other-app") })]),
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { prescriptionExerciseId: "e1", exerciseRef: "dumbbell-bench-press", substitution: substitution("bench-press") },
        { prescriptionExerciseId: "e2", exerciseRef: "lat-pulldown", substitution: null },
        // Two application ids are well-formed here; the server rejects them against its one authoritative application.
        { prescriptionExerciseId: "e3", exerciseRef: "seated-cable-row", substitution: substitution("barbell-row", "other-app") },
      ],
    });
  });

  it.each([
    ["a non-object substitution", "x"],
    ["null", null],
    ["a wrong kind", { ...substitution("x"), kind: "PAIN" }],
    ["a wrong reason", { ...substitution("x"), reasonCode: "OTHER" }],
    ["a wrong policy version", { ...substitution("x"), policyVersion: "equipment-adaptation/v2" }],
    ["an empty authored ref", { ...substitution("x"), authoredExerciseRef: "" }],
    ["an empty authored display name", { ...substitution("x"), authoredDisplayName: "" }],
    ["an empty catalog version", { ...substitution("x"), catalogVersion: "" }],
    ["a missing application id", { ...substitution("x"), equipmentApplicationId: undefined }],
    ["an extra field", { ...substitution("x"), substituteExerciseRef: "a" }],
    ["an array", [substitution("x")]],
  ])("%s -> MALFORMED_SUBSTITUTION (never a throw)", (_label, raw) => {
    expect(readSnapshotExerciseIdentities(snapshot([{ prescriptionExerciseId: "e1", exerciseRef: "a", displayName: "A", order: 1, sets: [], substitution: raw }]))).toEqual({ ok: false, error: "MALFORMED_SUBSTITUTION" });
  });

  it("a substitute without a performed exerciseRef -> MALFORMED_SUBSTITUTION", () => {
    expect(readSnapshotExerciseIdentities(snapshot([exercise("e1", null, { substitution: substitution("bench-press") })]))).toEqual({ ok: false, error: "MALFORMED_SUBSTITUTION" });
  });

  it.each([
    ["exercises is not an array", { exercises: "nope" }],
    ["a non-object exercise", { exercises: [null] }],
    ["a missing slot id", { exercises: [{ exerciseRef: "a" }] }],
    ["a missing exerciseRef key", { exercises: [{ prescriptionExerciseId: "e1" }] }],
    ["an empty exerciseRef", { exercises: [{ prescriptionExerciseId: "e1", exerciseRef: "" }] }],
    ["a numeric exerciseRef", { exercises: [{ prescriptionExerciseId: "e1", exerciseRef: 7 }] }],
  ])("%s -> MALFORMED_EXERCISE_IDENTITY (never a throw)", (_label, raw) => {
    expect(readSnapshotExerciseIdentities(raw as unknown as WorkoutPrescriptionV1)).toEqual({ ok: false, error: "MALFORMED_EXERCISE_IDENTITY" });
  });
});

describe("snapshotDeclaresSubstitution", () => {
  it("detects any substitution key, tolerates hostile shapes", () => {
    expect(snapshotDeclaresSubstitution(snapshot([exercise("e1", "a")]))).toBe(false);
    expect(snapshotDeclaresSubstitution(snapshot([exercise("e1", "a"), { prescriptionExerciseId: "e2", substitution: null }]))).toBe(true);
    expect(snapshotDeclaresSubstitution({ exercises: "nope" } as unknown as WorkoutPrescriptionV1)).toBe(false);
    expect(snapshotDeclaresSubstitution(snapshot([null, 1, "x"]))).toBe(false);
  });
});
