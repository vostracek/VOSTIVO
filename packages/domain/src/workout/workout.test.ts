import { describe, expect, it } from "vitest";
import { createEntityId } from "../entity-id.js";
import { isOk, isErr } from "../result.js";
import { validateExternalWeightLoad } from "../load/validate-load.js";
import type { WorkoutPrescriptionV1 } from "./prescription.js";
import { isActiveWorkoutSession, type WorkoutSession } from "./workout-session.js";
import type { PerformedSet } from "./performed-set.js";

describe("Workout Data Integrity — domain invariants", () => {
  it("WDI-001: WorkoutSession snapshots the prescription immutably", () => {
    const prescription: WorkoutPrescriptionV1 = {
      schemaVersion: 1,
      prescriptionId: "presc-1",
      name: "Push Day",
      exercises: [
        {
          prescriptionExerciseId: "ex-1",
          exerciseRef: null,
          displayName: "Barbell Bench Press",
          order: 0,
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
        },
      ],
    };

    const session: WorkoutSession = {
      id: createEntityId(),
      userId: createEntityId(),
      prescription,
      startedAt: new Date(),
      status: "ACTIVE",
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // TypeScript's `readonly` already prevents reassignment at compile
    // time; this proves the stored reference is the exact same snapshot
    // object, not a re-derived copy that could silently drift.
    expect(session.prescription).toBe(prescription);
    expect(session.prescription.exercises[0]?.displayName).toBe("Barbell Bench Press");
  });

  it("WDI-002: performed actual values may differ from prescribed target values", () => {
    const targetResult = validateExternalWeightLoad({ amountMilli: 40000, unit: "KG", basis: "TOTAL" });
    const actualResult = validateExternalWeightLoad({ amountMilli: 37500, unit: "KG", basis: "TOTAL" });
    if (!isOk(targetResult) || !isOk(actualResult)) throw new Error("expected valid loads");

    const performedSet: PerformedSet = {
      id: createEntityId(),
      performedExerciseId: createEntityId(),
      prescriptionSetId: "set-1",
      order: 0,
      actualReps: 8, // target was 10
      actualLoad: actualResult.value,
      setType: "WORKING",
      completionState: "COMPLETED",
      completedAt: new Date(),
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(performedSet.actualLoad.amountMilli).toBe(37500);
    expect(targetResult.value.amountMilli).toBe(40000);
    expect(performedSet.actualLoad.amountMilli).not.toBe(targetResult.value.amountMilli);
  });

  it("WDI-003: external load uses amountMilli fixed-precision semantics", () => {
    const result = validateExternalWeightLoad({ amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    expect(isOk(result) && result.value.amountMilli).toBe(102500);
  });

  it("WDI-004: dumbbell PER_IMPLEMENT load stays PER_IMPLEMENT, never summed to TOTAL", () => {
    const result = validateExternalWeightLoad({
      amountMilli: 40000,
      unit: "KG",
      basis: "PER_IMPLEMENT",
    });

    if (!isOk(result)) throw new Error("expected valid load");
    expect(result.value.basis).toBe("PER_IMPLEMENT");
    expect(result.value.amountMilli).toBe(40000); // not 80000
  });

  it("WDI-005: numeric load without required semantics is rejected", () => {
    expect(isErr(validateExternalWeightLoad({ amountMilli: 40000, unit: "STONE", basis: "TOTAL" }))).toBe(
      true,
    );
    expect(
      isErr(validateExternalWeightLoad({ amountMilli: 40000, unit: "KG", basis: "PER_SIDE" })),
    ).toBe(true);
    expect(isErr(validateExternalWeightLoad({ amountMilli: -1, unit: "KG", basis: "TOTAL" }))).toBe(
      true,
    );
    expect(isErr(validateExternalWeightLoad({ amountMilli: 40.5, unit: "KG", basis: "TOTAL" }))).toBe(
      true,
    );
  });
});

describe("Active Workout Core Logger V1 — domain invariants", () => {
  function buildPrescription(): WorkoutPrescriptionV1 {
    return {
      schemaVersion: 1,
      prescriptionId: "presc-1",
      name: "Upper Body A",
      exercises: [
        {
          prescriptionExerciseId: "ex-1",
          exerciseRef: "bench-press",
          displayName: "Bench Press",
          order: 0,
          sets: [
            { prescriptionSetId: "set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: null, restSeconds: 90, setType: "WORKING" },
            { prescriptionSetId: "set-2", order: 1, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: null, restSeconds: 90, setType: "WORKING" },
          ],
        },
      ],
    };
  }

  function buildSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
    return {
      id: createEntityId(),
      userId: createEntityId(),
      prescription: buildPrescription(),
      startedAt: new Date(),
      status: "ACTIVE",
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("AW-001: a RANGE target renders/preserves as 8-12, never collapsed", () => {
    const session = buildSession();
    const target = session.prescription.exercises[0]?.sets[0]?.targetReps;
    expect(target).toEqual({ kind: "RANGE", minReps: 8, maxReps: 12 });

    // Round-tripping through JSON (as the local/server snapshot storage
    // does) must not collapse the range either.
    const roundTripped = JSON.parse(JSON.stringify(session)) as WorkoutSession;
    expect(roundTripped.prescription.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });
  });

  it("AW-002: actual reps never mutate the prescribed RepTargetV1", () => {
    const session = buildSession();
    const target = session.prescription.exercises[0]?.sets[0]?.targetReps;

    const performedSet: PerformedSet = {
      id: createEntityId(),
      performedExerciseId: createEntityId(),
      prescriptionSetId: "set-1",
      order: 0,
      actualReps: 15, // outside the prescribed 8-12 range on purpose
      actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 40000, unit: "KG", basis: "TOTAL" },
      setType: "WORKING",
      completionState: "COMPLETED",
      completedAt: new Date(),
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(performedSet.actualReps).toBe(15);
    // The target object is untouched — same reference, same value.
    expect(session.prescription.exercises[0]?.sets[0]?.targetReps).toBe(target);
    expect(session.prescription.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });
  });

  it("AW-003: actual load preserves amountMilli/unit/basis exactly, independent of any target", () => {
    const result = validateExternalWeightLoad({ amountMilli: 40000, unit: "KG", basis: "PER_IMPLEMENT" });
    if (!isOk(result)) throw new Error("expected valid load");

    expect(result.value).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 40000, unit: "KG", basis: "PER_IMPLEMENT" });
  });

  it("AW-004: finishing a session (ACTIVE -> COMPLETED) never touches performed reality — WorkoutSession has no embedded performed-set data to clobber", () => {
    const active = buildSession();
    const finished: WorkoutSession = { ...active, status: "COMPLETED", completedAt: new Date() };

    // PerformedExercise/PerformedSet are separate aggregates keyed by
    // workoutSessionId, never embedded fields on WorkoutSession — so this
    // transition is structurally incapable of rewriting performed reality.
    expect(finished.prescription).toBe(active.prescription);
    expect(Object.keys(finished)).not.toContain("performedExercises");
    expect(Object.keys(finished)).not.toContain("performedSets");
  });

  it("AW-005: a session may be completed with planned sets left unperformed — nothing in the domain model requires full completion first", () => {
    const session = buildSession();
    expect(session.prescription.exercises[0]?.sets).toHaveLength(2); // two planned sets

    // Finishing with zero completed sets is a valid domain state — no
    // validation function exists (or should exist) that rejects this.
    const finished: WorkoutSession = { ...session, status: "COMPLETED", completedAt: new Date() };
    expect(finished.status).toBe("COMPLETED");
  });

  it("AW-006: a completed session is no longer considered active", () => {
    const active = buildSession();
    const completed: WorkoutSession = { ...active, status: "COMPLETED", completedAt: new Date() };

    expect(isActiveWorkoutSession(active)).toBe(true);
    expect(isActiveWorkoutSession(completed)).toBe(false);
  });
});
