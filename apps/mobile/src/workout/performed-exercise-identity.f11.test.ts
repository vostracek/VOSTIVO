import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { CompleteSetCommandV1, WorkoutCommandV1 } from "@vostivo/contracts";
import {
  createEntityId,
  type ExternalWeightLoad,
  type PrescribedExerciseV1,
  type WorkoutPrescriptionV1,
} from "@vostivo/domain";
import {
  openTestLocalDatabase,
  type TestDatabaseConnection,
} from "../local-database/testing/node-sqlite-database";
import { WorkoutRepository, type CompleteSetInput } from "./workout-repository";

/**
 * CORE-FIX-11 (F-11) — one planned prescription exercise slot of a workout
 * session has exactly ONE canonical local performed exercise, and one
 * planned set slot is completed at most once unless explicitly corrected
 * (reopen -> recomplete of the same set). Active Workout passes the ids it
 * last rendered, so a second tap before the post-commit refresh arrives
 * without them — the repository must resolve identity itself, inside its
 * own transaction. REAL repository SQL on a REAL file-backed SQLite; closing
 * and reopening the file models process death. All data is synthetic.
 */
const LOAD: ExternalWeightLoad = {
  kind: "EXTERNAL_WEIGHT",
  amountMilli: 60000,
  unit: "KG",
  basis: "TOTAL",
};
const RANGE = { kind: "RANGE", minReps: 8, maxReps: 12 } as const;

function exercise(
  id: string,
  exerciseRef: string,
  order: number,
  extra: Partial<PrescribedExerciseV1> = {},
): PrescribedExerciseV1 {
  return {
    prescriptionExerciseId: id,
    exerciseRef,
    displayName: exerciseRef,
    order,
    sets: [0, 1, 2, 3].map((n) => ({
      prescriptionSetId: `${id}-set-${n + 1}`,
      order: n,
      targetReps: RANGE,
      targetLoad: LOAD,
      restSeconds: 90,
      setType: "WORKING" as const,
    })),
    ...extra,
  };
}

const PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "f11-prescription",
  name: "F11 Upper",
  exercises: [
    exercise("f11-bench-a", "bench-press", 0),
    // Same exerciseRef, a DIFFERENT planned slot (e.g. a back-off block):
    // a legitimate second performed exercise.
    exercise("f11-bench-b", "bench-press", 1),
    // A substituted slot keeps its planned slot identity.
    exercise("f11-ohp", "seated-dumbbell-overhead-press", 2, {
      substitution: {
        kind: "TEMPORARY_EQUIPMENT",
        authoredExerciseRef: "overhead-press",
        authoredDisplayName: "Overhead Press",
        equipmentAdaptationApplicationId: "019a0000-0000-7000-8000-0000000000aa",
      } as unknown as PrescribedExerciseV1["substitution"],
    }),
  ],
};

function setInput(
  workoutSessionId: string,
  slot: PrescribedExerciseV1,
  setNumber: number,
  overrides: Partial<CompleteSetInput> = {},
): CompleteSetInput {
  const set = slot.sets[setNumber - 1]!;
  return {
    workoutSessionId,
    prescriptionExerciseId: slot.prescriptionExerciseId,
    exerciseRef: slot.exerciseRef,
    exerciseDisplayName: slot.displayName,
    exerciseOrder: slot.order,
    prescriptionSetId: set.prescriptionSetId,
    setOrder: set.order,
    actualReps: 12,
    actualLoad: LOAD,
    setType: "WORKING",
    ...overrides,
  };
}

const [BENCH_A, BENCH_B, OHP] = PRESCRIPTION.exercises as [
  PrescribedExerciseV1,
  PrescribedExerciseV1,
  PrescribedExerciseV1,
];

describe("CORE-FIX-11 performed exercise identity (real local SQLite)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;

  function open(): void {
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
  }
  function reopenProcess(): void {
    connection.close();
    open();
  }

  async function start(): Promise<string> {
    const outcome = await repository.startWorkoutSession(PRESCRIPTION);
    if (outcome.status !== "STARTED") throw new Error("expected STARTED");
    return outcome.session.id;
  }

  const exercisesFor = (sessionId: string, slot: string | null) =>
    connection.db.all<{ id: string }>(
      slot === null
        ? sql`SELECT id FROM local_performed_exercises WHERE workout_session_id = ${sessionId} AND prescription_exercise_id IS NULL`
        : sql`SELECT id FROM local_performed_exercises WHERE workout_session_id = ${sessionId} AND prescription_exercise_id = ${slot}`,
    );
  const setsFor = (prescriptionSetId: string) =>
    connection.db.all<{
      id: string;
      performed_exercise_id: string;
      revision: number;
      actual_reps: number;
      completion_state: string;
    }>(
      sql`SELECT id, performed_exercise_id, revision, actual_reps, completion_state FROM local_performed_sets WHERE prescription_set_id = ${prescriptionSetId}`,
    );
  const outbox = (): WorkoutCommandV1[] =>
    connection.db
      .all<{ payload_json: string }>(
        sql`SELECT payload_json FROM sync_outbox ORDER BY created_at ASC, rowid ASC`,
      )
      .map((row) => JSON.parse(row.payload_json) as WorkoutCommandV1);
  const completeCommands = () =>
    outbox().filter((c): c is CompleteSetCommandV1 => c.type === "COMPLETE_SET_V1");
  const lastIssuedSeq = (sessionId: string) =>
    connection.db.get<{ n: number }>(
      sql`SELECT last_issued_session_seq AS n FROM local_workout_sessions WHERE id = ${sessionId}`,
    )?.n;

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-f11-identity-${createEntityId()}.db`;
    open();
  });

  afterEach(() => {
    connection.close();
    rmSync(path, { force: true });
  });

  it("F11-M01 normal sequential logging (ids passed back) -> one performed exercise, one command id per slot", async () => {
    const sessionId = await start();
    let performedExerciseId: string | undefined;
    for (const n of [1, 2, 3, 4]) {
      const outcome = await repository.completeSet(
        setInput(sessionId, BENCH_A, n, { performedExerciseId }),
      );
      if (outcome.status !== "COMPLETED") throw new Error("expected COMPLETED");
      performedExerciseId = outcome.result.performedExerciseId;
    }
    expect(exercisesFor(sessionId, BENCH_A.prescriptionExerciseId)).toHaveLength(1);
    expect(new Set(completeCommands().map((c) => c.performedExerciseId))).toEqual(
      new Set([performedExerciseId]),
    );
    expect(completeCommands().map((c) => c.sessionSeq)).toEqual([1, 2, 3, 4]);
  });

  it("F11-M02 rapid logging: later sets arrive without the id (stale render) -> still ONE performed exercise", async () => {
    const sessionId = await start();
    for (const n of [1, 2, 3, 4]) await repository.completeSet(setInput(sessionId, BENCH_A, n));
    const rows = exercisesFor(sessionId, BENCH_A.prescriptionExerciseId);
    expect(rows).toHaveLength(1);
    expect(completeCommands()).toHaveLength(4);
    expect(new Set(completeCommands().map((c) => c.performedExerciseId))).toEqual(
      new Set([rows[0]!.id]),
    );
    const active = await repository.getActiveWorkoutSession();
    const shown = active!.exercises.filter(
      (e) => e.prescriptionExerciseId === BENCH_A.prescriptionExerciseId,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.sets.map((s) => s.prescriptionSetId).sort()).toEqual(
      BENCH_A.sets.map((s) => s.prescriptionSetId).sort(),
    );
  });

  it("F11-M03 double tap on the same set (sequential, both stale) -> one set, one command, second is ALREADY_COMPLETED", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    const second = await repository.completeSet(
      setInput(sessionId, BENCH_A, 1, { actualReps: 11 }),
    );
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(second).toEqual({ status: "ALREADY_COMPLETED", result: first.result });
    expect(setsFor(BENCH_A.sets[0]!.prescriptionSetId)).toEqual([
      expect.objectContaining({
        id: first.result.performedSetId,
        revision: 1,
        actual_reps: 12,
        completion_state: "COMPLETED",
      }),
    ]);
    expect(completeCommands()).toHaveLength(1);
    expect(lastIssuedSeq(sessionId)).toBe(1); // no sessionSeq burned by the no-op
  });

  it("F11-M04 concurrent completeSet calls (same set and a different set of the same slot) -> one exercise, no duplicate set", async () => {
    const sessionId = await start();
    const outcomes = await Promise.all([
      repository.completeSet(setInput(sessionId, BENCH_A, 1)),
      repository.completeSet(setInput(sessionId, BENCH_A, 1)),
      repository.completeSet(setInput(sessionId, BENCH_A, 2)),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "ALREADY_COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(exercisesFor(sessionId, BENCH_A.prescriptionExerciseId)).toHaveLength(1);
    expect(setsFor(BENCH_A.sets[0]!.prescriptionSetId)).toHaveLength(1);
    expect(setsFor(BENCH_A.sets[1]!.prescriptionSetId)).toHaveLength(1);
    expect(completeCommands()).toHaveLength(2);
  });

  it("F11-M05 a stale/foreign caller-provided performedExerciseId never forks the slot", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    // The id of ANOTHER slot (e.g. a render for the wrong tab) is a programming error, not a new exercise.
    const otherSlot = await repository.completeSet(setInput(sessionId, BENCH_B, 1));
    if (otherSlot.status !== "COMPLETED") throw new Error("expected COMPLETED");
    await expect(
      repository.completeSet(
        setInput(sessionId, BENCH_A, 2, {
          performedExerciseId: otherSlot.result.performedExerciseId,
        }),
      ),
    ).rejects.toThrow(/does not belong to this exercise slot/);
    // An id that does not exist locally at all is resolved to the canonical slot.
    const third = await repository.completeSet(
      setInput(sessionId, BENCH_A, 3, { performedExerciseId: createEntityId() }),
    );
    if (third.status !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(third.result.performedExerciseId).toBe(first.result.performedExerciseId);
    expect(exercisesFor(sessionId, BENCH_A.prescriptionExerciseId)).toHaveLength(1);
    expect(completeCommands().map((c) => c.prescriptionSetId)).toEqual([
      BENCH_A.sets[0]!.prescriptionSetId,
      BENCH_B.sets[0]!.prescriptionSetId,
      BENCH_A.sets[2]!.prescriptionSetId,
    ]);
  });

  it("F11-M06 restart between sets -> the canonical id is re-resolved from disk", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    reopenProcess();
    const second = await repository.completeSet(setInput(sessionId, BENCH_A, 2));
    if (second.status !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(second.result.performedExerciseId).toBe(first.result.performedExerciseId);
    reopenProcess();
    expect((await repository.completeSet(setInput(sessionId, BENCH_A, 2))).status).toBe(
      "ALREADY_COMPLETED",
    );
    expect(exercisesFor(sessionId, BENCH_A.prescriptionExerciseId)).toHaveLength(1);
  });

  it("F11-M07 offline logging: the persisted outbox carries one identity and is resent verbatim after restart", async () => {
    const sessionId = await start();
    for (const n of [1, 2, 3, 4]) await repository.completeSet(setInput(sessionId, BENCH_A, n));
    await repository.completeSet(setInput(sessionId, BENCH_A, 4)); // late double tap, still offline
    await repository.finishWorkoutSession(sessionId);
    const before = JSON.stringify(outbox());
    reopenProcess();
    const pending = await repository.getPendingCommands(100);
    expect(JSON.stringify(outbox())).toBe(before); // nothing rewritten on reopen
    expect(pending.map((p) => p.payload.type)).toEqual([
      "START_WORKOUT_SESSION_V1",
      "COMPLETE_SET_V1",
      "COMPLETE_SET_V1",
      "COMPLETE_SET_V1",
      "COMPLETE_SET_V1",
      "FINISH_WORKOUT_SESSION_V1",
    ]);
    expect(new Set(completeCommands().map((c) => c.performedSetId)).size).toBe(4);
    expect(new Set(completeCommands().map((c) => c.performedExerciseId)).size).toBe(1);
  });

  it("F11-M09 reopen + correction stay legitimate; a stale completion of a REOPENED set recompletes that same set", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    await repository.reopenSet(first.result.performedSetId);
    const corrected = await repository.completeSet(
      setInput(sessionId, BENCH_A, 1, {
        performedExerciseId: first.result.performedExerciseId,
        performedSetId: first.result.performedSetId,
        actualReps: 10,
      }),
    );
    expect(corrected).toEqual({ status: "COMPLETED", result: { ...first.result, revision: 3 } });
    await repository.reopenSet(first.result.performedSetId);
    // Stale render after the second reopen: no ids at all.
    const staleRecomplete = await repository.completeSet(
      setInput(sessionId, BENCH_A, 1, { actualReps: 9 }),
    );
    expect(staleRecomplete).toEqual({
      status: "COMPLETED",
      result: { ...first.result, revision: 5 },
    });
    expect(setsFor(BENCH_A.sets[0]!.prescriptionSetId)).toEqual([
      expect.objectContaining({
        id: first.result.performedSetId,
        revision: 5,
        actual_reps: 9,
        completion_state: "COMPLETED",
      }),
    ]);
    expect(
      outbox()
        .filter((c) => c.type !== "START_WORKOUT_SESSION_V1")
        .map((c) => c.type),
    ).toEqual([
      "COMPLETE_SET_V1",
      "REOPEN_SET_V1",
      "COMPLETE_SET_V1",
      "REOPEN_SET_V1",
      "COMPLETE_SET_V1",
    ]);
  });

  it("F11-M10 the same exerciseRef in two planned slots stays two performed exercises", async () => {
    const sessionId = await start();
    await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    await repository.completeSet(setInput(sessionId, BENCH_B, 1));
    await repository.completeSet(setInput(sessionId, BENCH_B, 2));
    expect(exercisesFor(sessionId, BENCH_A.prescriptionExerciseId)).toHaveLength(1);
    expect(exercisesFor(sessionId, BENCH_B.prescriptionExerciseId)).toHaveLength(1);
    const ids = new Set(completeCommands().map((c) => c.performedExerciseId));
    expect(ids.size).toBe(2);
  });

  it("F11-M11 a substituted slot keeps its planned slot identity (one row, substitute exerciseRef)", async () => {
    const sessionId = await start();
    for (const n of [1, 2]) await repository.completeSet(setInput(sessionId, OHP, n));
    const rows = connection.db.all<{ exercise_ref: string }>(
      sql`SELECT exercise_ref FROM local_performed_exercises WHERE workout_session_id = ${sessionId} AND prescription_exercise_id = ${OHP.prescriptionExerciseId}`,
    );
    expect(rows).toEqual([{ exercise_ref: "seated-dumbbell-overhead-press" }]);
  });

  it("F11-M12 unplanned exercises (null slot) keep their existing identity behavior", async () => {
    const sessionId = await start();
    const unplanned = (overrides: Partial<CompleteSetInput>): CompleteSetInput => ({
      ...setInput(sessionId, BENCH_A, 1),
      prescriptionExerciseId: null,
      prescriptionSetId: null,
      exerciseRef: "cable-fly",
      exerciseDisplayName: "Cable Fly",
      exerciseOrder: 9,
      ...overrides,
    });
    const a = await repository.completeSet(unplanned({}));
    if (a.status !== "COMPLETED") throw new Error("expected COMPLETED");
    // Passing the id back adds to the same unplanned exercise ...
    const b = await repository.completeSet(
      unplanned({ performedExerciseId: a.result.performedExerciseId }),
    );
    if (b.status !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(b.result.performedExerciseId).toBe(a.result.performedExerciseId);
    expect(b.result.performedSetId).not.toBe(a.result.performedSetId); // unplanned sets have no slot to collide on
    // ... and omitting it is still a NEW unplanned exercise (no slot identity to resolve).
    await repository.completeSet(
      unplanned({ exerciseRef: "lateral-raise", exerciseDisplayName: "Lateral Raise" }),
    );
    expect(exercisesFor(sessionId, null)).toHaveLength(2);
  });

  it("F11-M13 another session never reuses a previous session's performed exercise", async () => {
    const first = await start();
    await repository.completeSet(setInput(first, BENCH_A, 1));
    await repository.finishWorkoutSession(first);
    const second = await start();
    const outcome = await repository.completeSet(setInput(second, BENCH_A, 1));
    expect(outcome.status).toBe("COMPLETED");
    const [a] = exercisesFor(first, BENCH_A.prescriptionExerciseId);
    const [b] = exercisesFor(second, BENCH_A.prescriptionExerciseId);
    expect(a!.id).not.toBe(b!.id);
  });

  it("F11-M14 an already completed workout still refuses any set mutation (terminal invariant unchanged)", async () => {
    const sessionId = await start();
    await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    await repository.finishWorkoutSession(sessionId);
    expect(await repository.completeSet(setInput(sessionId, BENCH_A, 1))).toEqual({
      status: "SESSION_ALREADY_COMPLETED",
    });
    expect(await repository.completeSet(setInput(sessionId, BENCH_A, 2))).toEqual({
      status: "SESSION_ALREADY_COMPLETED",
    });
    expect(setsFor(BENCH_A.sets[1]!.prescriptionSetId)).toEqual([]);
    expect(completeCommands()).toHaveLength(1);
  });

  it("F11-M15 a pre-fix fragmented local session (two rows for one slot) is read and extended deterministically", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId, BENCH_A, 1));
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    // Simulate what a pre-fix build left on disk: a second row for the slot holding set 2.
    const fragmentId = createEntityId();
    const now = new Date(Date.now() + 1000).toISOString();
    connection.db
      .run(sql`INSERT INTO local_performed_exercises (id, workout_session_id, prescription_exercise_id, exercise_ref, display_name, order_index, created_at, updated_at)
      VALUES (${fragmentId}, ${sessionId}, ${BENCH_A.prescriptionExerciseId}, 'bench-press', 'bench-press', 0, ${now}, ${now})`);
    connection.db
      .run(sql`INSERT INTO local_performed_sets (id, performed_exercise_id, prescription_set_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, set_type, completion_state, completed_at, revision, created_at, updated_at)
      VALUES (${createEntityId()}, ${fragmentId}, ${BENCH_A.sets[1]!.prescriptionSetId}, 1, 12, 'EXTERNAL_WEIGHT', 60000, 'KG', 'TOTAL', 'WORKING', 'COMPLETED', ${now}, 1, ${now}, ${now})`);
    // The already-logged set 2 (in the fragment) is recognized, not logged again ...
    expect((await repository.completeSet(setInput(sessionId, BENCH_A, 2))).status).toBe(
      "ALREADY_COMPLETED",
    );
    // ... and new sets go to the earliest (canonical) row.
    const third = await repository.completeSet(setInput(sessionId, BENCH_A, 3));
    if (third.status !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(third.result.performedExerciseId).toBe(first.result.performedExerciseId);
  });
});
