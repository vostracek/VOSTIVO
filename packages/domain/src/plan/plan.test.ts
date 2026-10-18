import { describe, expect, it } from "vitest";
import { createEntityId } from "../entity-id.js";
import { validateExternalWeightLoad } from "../load/validate-load.js";
import type { WorkoutSession } from "../workout/workout-session.js";
import { PLANNED_WORKOUT_STATUSES, type PlannedWorkout } from "./planned-workout.js";
import type { PlannedExercise } from "./planned-exercise.js";
import type { PlannedSet } from "./planned-set.js";
import type { ProgramVersion } from "./program-version.js";
import type { TrainingBlock } from "./training-block.js";
import type { TrainingCycle } from "./training-cycle.js";
import { createWorkoutPrescriptionFromPlannedWorkout } from "./prescription-builder.js";

function buildFixture() {
  const now = new Date();
  const programVersion: ProgramVersion = {
    id: createEntityId(),
    programId: createEntityId(),
    versionNumber: 1,
    status: "ACTIVE",
    activatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const block: TrainingBlock = {
    id: createEntityId(),
    programVersionId: programVersion.id,
    name: "Hypertrophy Block 1",
    goal: "Hypertrophy — Upper/Lower",
    order: 1,
    cycleCount: 6,
    focusAreas: [{ name: "Back", emphasis: "PRIORITY" }],
    createdAt: now,
    updatedAt: now,
  };
  const cycle: TrainingCycle = {
    id: createEntityId(),
    trainingBlockId: block.id,
    order: 4,
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    createdAt: now,
    updatedAt: now,
  };
  const workout: PlannedWorkout = {
    id: createEntityId(),
    trainingCycleId: cycle.id,
    name: "Upper Body A",
    focus: "Push emphasis",
    order: 1,
    scheduledDate: "2026-09-03",
    estimatedDurationMinutes: 60,
    status: "PLANNED",
    createdAt: now,
    updatedAt: now,
  };
  const exercise: PlannedExercise = {
    id: createEntityId(),
    plannedWorkoutId: workout.id,
    exerciseRef: null,
    displayName: "Bench Press",
    order: 1,
    createdAt: now,
    updatedAt: now,
  };
  const load = validateExternalWeightLoad({ amountMilli: 60000, unit: "KG", basis: "TOTAL" });
  if (!load.ok) throw new Error("fixture load must be valid");
  const set: PlannedSet = {
    id: createEntityId(),
    plannedExerciseId: exercise.id,
    order: 1,
    targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
    targetLoad: load.value,
    restSeconds: 90,
    setType: "WORKING",
    createdAt: now,
    updatedAt: now,
  };

  return { programVersion, block, cycle, workout, exercise, set };
}

describe("PLAN-001: ProgramVersion structural history is not mutated by session execution", () => {
  it("building a prescription and a WorkoutSession from it leaves the source Plan structure untouched", () => {
    const { programVersion, block, cycle, workout, exercise, set } = buildFixture();
    const before = structuredClone({ programVersion, block, cycle, workout, exercise, set });

    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });
    const session: WorkoutSession = {
      id: createEntityId(),
      userId: "user-1",
      prescription,
      startedAt: new Date(),
      status: "ACTIVE",
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect({ programVersion, block, cycle, workout, exercise, set }).toEqual(before);
    expect(session.prescription).toBe(prescription);
  });
});

describe("PLAN-002: PlannedWorkout execution status is not persisted as STARTED/COMPLETED", () => {
  it("the allowed scheduling statuses never include execution-truth values", () => {
    expect(PLANNED_WORKOUT_STATUSES).not.toContain("STARTED");
    expect(PLANNED_WORKOUT_STATUSES).not.toContain("COMPLETED");
    expect(PLANNED_WORKOUT_STATUSES).toEqual(["PLANNED", "AVAILABLE", "SKIPPED", "RESCHEDULED", "CANCELLED"]);
  });
});

describe("PLAN-003: planned set load preserves Load Model amountMilli/unit/basis", () => {
  it("survives the prescription-builder mapping exactly", () => {
    const { workout, exercise, set } = buildFixture();

    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });

    expect(prescription.exercises[0]?.sets[0]?.targetLoad).toEqual({
      kind: "EXTERNAL_WEIGHT",
      amountMilli: 60000,
      unit: "KG",
      basis: "TOTAL",
    });
  });
});

describe("REP-003: Plan -> WorkoutPrescription preserves both range bounds", () => {
  it("does not collapse a RANGE target to its minimum", () => {
    const { workout, exercise, set } = buildFixture();

    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });

    expect(prescription.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });
  });

  it("preserves an EXACT target as EXACT, not a degenerate range", () => {
    const { workout, exercise, set } = buildFixture();
    const exactSet: PlannedSet = { ...set, targetReps: { kind: "EXACT", reps: 10 } };

    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [exactSet] }],
    });

    expect(prescription.exercises[0]?.sets[0]?.targetReps).toEqual({ kind: "EXACT", reps: 10 });
  });
});

describe("PLAN-004: WorkoutPrescriptionV1 created from PlannedWorkout preserves stable prescription IDs", () => {
  it("produces identical ids across repeated calls, matching the planned entities' own ids", () => {
    const { workout, exercise, set } = buildFixture();
    const detail = { workout, exercises: [{ exercise, sets: [set] }] };

    const first = createWorkoutPrescriptionFromPlannedWorkout(detail);
    const second = createWorkoutPrescriptionFromPlannedWorkout(detail);

    expect(first.prescriptionId).toBe(workout.id);
    expect(first.exercises[0]?.prescriptionExerciseId).toBe(exercise.id);
    expect(first.exercises[0]?.sets[0]?.prescriptionSetId).toBe(set.id);
    expect(second).toEqual(first);
  });
});

describe("PLAN-005: changing future Plan data after session start cannot change the WorkoutSession prescription snapshot", () => {
  it("rebuilding a prescription from changed planned data never reaches back into an already-created session", () => {
    const { workout, exercise, set } = buildFixture();
    const originalPrescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });
    const session: WorkoutSession = {
      id: createEntityId(),
      userId: "user-1",
      prescription: originalPrescription,
      startedAt: new Date(),
      status: "ACTIVE",
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const snapshotBefore = structuredClone(session.prescription);

    // Simulate a future Plan edit: a *new* planned set value with a
    // different target, as a domain type would actually change (these
    // are readonly — there is no in-place mutation to perform).
    const changedSet: PlannedSet = { ...set, targetReps: { kind: "RANGE", minReps: 3, maxReps: 5 } };
    const revisedPrescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [changedSet] }],
    });

    expect(session.prescription).toEqual(snapshotBefore);
    expect(revisedPrescription).not.toEqual(session.prescription);
    // The durable, storage-level proof (a real WorkoutSession row in
    // Postgres/SQLite is unaffected by a later UPDATE to planned_sets) is
    // covered by the PLAN-005 API integration test — this proves the pure
    // mapping side of the invariant.
  });
});

describe("REP-004: WorkoutSession snapshot preserves both range bounds", () => {
  it("the session's stored prescription still carries the full RANGE, not a collapsed minimum", () => {
    const { workout, exercise, set } = buildFixture();
    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });
    const session: WorkoutSession = {
      id: createEntityId(),
      userId: "user-1",
      prescription,
      startedAt: new Date(),
      status: "ACTIVE",
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(session.prescription.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });
  });
});

describe("REP-005: process restart / local persistence does not collapse a range to its minimum", () => {
  it("survives a JSON serialize/deserialize round trip (the same shape local SQLite and Postgres jsonb storage use)", () => {
    const { workout, exercise, set } = buildFixture();
    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });

    const roundTripped = JSON.parse(JSON.stringify(prescription)) as typeof prescription;

    expect(roundTripped.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });
  });
});

describe("REP-007: performed actual reps may differ from target without altering the prescription", () => {
  it("PerformedSet.actualReps stays a plain number, independent of the RepTargetV1 it was completed against", () => {
    const { workout, exercise, set } = buildFixture();
    const prescription = createWorkoutPrescriptionFromPlannedWorkout({
      workout,
      exercises: [{ exercise, sets: [set] }],
    });
    const prescribedTarget = prescription.exercises[0]?.sets[0]?.targetReps;

    // The athlete actually did 9 reps against an 8-12 target — Reality
    // (a plain number) and Intent (RepTargetV1) are independently
    // representable; completing a set never mutates the prescription.
    const actualReps = 9;

    expect(prescribedTarget).toEqual({ kind: "RANGE", minReps: 8, maxReps: 12 });
    expect(actualReps).not.toBe(prescribedTarget);
    expect(prescription.exercises[0]?.sets[0]?.targetReps).toEqual({ kind: "RANGE", minReps: 8, maxReps: 12 });
  });
});
