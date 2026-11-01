import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { WorkoutCommandV1 } from "@vostivo/contracts";
import { createEntityId, type ExternalWeightLoad, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { WorkoutRepository, type CompleteSetInput } from "./workout-repository";
import { normalizeStoredPrescription } from "./prescription-compat";

/**
 * CC-01 Strength Regression Baseline — the local session lifecycle on the
 * REAL repository SQL and a REAL file-backed SQLite. Closing and reopening the
 * file models process death honestly. All data here is synthetic.
 */
const TARGET_LOAD: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };
const ACTUAL_LOAD: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 57500, unit: "KG", basis: "TOTAL" };

const PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "cc01-prescription",
  name: "CC01 Upper",
  exercises: [
    {
      prescriptionExerciseId: "cc01-ex-1",
      exerciseRef: "bench-press",
      displayName: "Bench Press",
      order: 0,
      sets: [
        { prescriptionSetId: "cc01-set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: TARGET_LOAD, restSeconds: 120, setType: "WORKING" },
        { prescriptionSetId: "cc01-set-2", order: 1, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: TARGET_LOAD, restSeconds: 120, setType: "WORKING" },
      ],
    },
  ],
};

function setInput(workoutSessionId: string, overrides: Partial<CompleteSetInput> = {}): CompleteSetInput {
  return {
    workoutSessionId,
    prescriptionExerciseId: "cc01-ex-1",
    exerciseRef: "bench-press",
    exerciseDisplayName: "Bench Press",
    exerciseOrder: 0,
    prescriptionSetId: "cc01-set-1",
    setOrder: 0,
    actualReps: 7,
    actualLoad: ACTUAL_LOAD,
    setType: "WORKING",
    ...overrides,
  };
}

function outboxRows(connection: TestDatabaseConnection): { type: string; status: string; command: WorkoutCommandV1 }[] {
  return connection.db
    .all<{ command_type: string; status: string; payload_json: string }>(
      sql`SELECT command_type, status, payload_json FROM sync_outbox ORDER BY created_at ASC, rowid ASC`,
    )
    .map((row) => ({ type: row.command_type, status: row.status, command: JSON.parse(row.payload_json) as WorkoutCommandV1 }));
}

function count(connection: TestDatabaseConnection, table: "local_performed_sets" | "sync_outbox"): number {
  return connection.db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))?.n ?? -1;
}

describe("CC-01 Strength session lifecycle (real local SQLite)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;

  function open(): void {
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
  }

  async function start(): Promise<string> {
    const outcome = await repository.startWorkoutSession(PRESCRIPTION);
    if (outcome.status !== "STARTED") throw new Error("expected STARTED");
    return outcome.session.id;
  }

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-cc01-lifecycle-${createEntityId()}.db`;
    open();
  });

  afterEach(() => {
    connection.close();
    rmSync(path, { force: true });
  });

  it("CC01-LIFE-001: START, COMPLETE, REOPEN, COMPLETE, FINISH issue ordered commands with monotonic revision and sessionSeq", async () => {
    const sessionId = await start();
    const first = await repository.completeSet(setInput(sessionId));
    if (first.status !== "COMPLETED") throw new Error("expected COMPLETED");
    const { performedExerciseId, performedSetId } = first.result;
    await repository.reopenSet(performedSetId);
    await repository.completeSet(setInput(sessionId, { performedExerciseId, performedSetId, actualReps: 8 }));
    const finished = await repository.finishWorkoutSession(sessionId);
    expect(finished.status).toBe("FINISHED");

    const rows = outboxRows(connection);
    expect(rows.map((row) => row.type)).toEqual([
      "START_WORKOUT_SESSION_V1",
      "COMPLETE_SET_V1",
      "REOPEN_SET_V1",
      "COMPLETE_SET_V1",
      "FINISH_WORKOUT_SESSION_V1",
    ]);
    expect(rows.every((row) => row.status === "PENDING")).toBe(true);

    const [, complete1, reopen, complete2, finish] = rows.map((row) => row.command);
    expect(complete1).toMatchObject({ revision: 1, sessionSeq: 1 });
    expect(reopen).toMatchObject({ revision: 2, sessionSeq: 2 });
    expect(complete2).toMatchObject({ revision: 3, sessionSeq: 3, actualReps: 8 });
    expect(finish).toMatchObject({ workoutSessionId: sessionId, finishSeq: 3 });
  });

  it("CC01-LIFE-002: planned and performed stay separate: the snapshot is byte-identical after logging different values", async () => {
    const sessionId = await start();
    const before = connection.db.get<{ prescription_json: string }>(sql`SELECT prescription_json FROM local_workout_sessions WHERE id = ${sessionId}`);

    await repository.completeSet(setInput(sessionId, { actualReps: 7, actualLoad: ACTUAL_LOAD }));
    await repository.finishWorkoutSession(sessionId);

    const after = connection.db.get<{ prescription_json: string }>(sql`SELECT prescription_json FROM local_workout_sessions WHERE id = ${sessionId}`);
    expect(after?.prescription_json).toBe(before?.prescription_json);
    expect(after?.prescription_json).toBe(JSON.stringify(PRESCRIPTION));

    const performed = connection.db.get<{ actual_reps: number; load_amount_milli: number; prescription_set_id: string }>(
      sql`SELECT actual_reps, load_amount_milli, prescription_set_id FROM local_performed_sets`,
    );
    expect(performed).toEqual({ actual_reps: 7, load_amount_milli: 57500, prescription_set_id: "cc01-set-1" });
  });

  it("CC01-LIFE-003: an active session, its sets, drafts and outbox survive process death", async () => {
    const sessionId = await start();
    await repository.completeSet(setInput(sessionId));
    await repository.saveSetDraft({
      workoutSessionId: sessionId,
      prescriptionExerciseId: "cc01-ex-1",
      prescriptionSetId: "cc01-set-2",
      draftReps: 9,
      draftLoad: ACTUAL_LOAD,
    });
    const pendingBefore = await repository.getPendingCommands(25);

    connection.close();
    open();

    const session = await repository.getActiveWorkoutSession();
    expect(session?.id).toBe(sessionId);
    expect(session?.prescription).toEqual(PRESCRIPTION);
    expect(session?.exercises[0]?.sets).toHaveLength(1);
    expect(session?.drafts).toEqual([expect.objectContaining({ prescriptionSetId: "cc01-set-2", draftReps: 9 })]);
    expect(await repository.getPendingCommands(25)).toEqual(pendingBefore);
  });

  it("CC01-LIFE-004: a failed outbox write rolls back the performed set: reality and command stay atomic", async () => {
    const sessionId = await start();
    connection.exec("CREATE TRIGGER cc01_fail BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'cc01 forced failure'); END;");

    await expect(repository.completeSet(setInput(sessionId))).rejects.toThrow();

    expect(count(connection, "local_performed_sets")).toBe(0);
    expect(count(connection, "sync_outbox")).toBe(1); // only START
    const seq = connection.db.get<{ last_issued_session_seq: number }>(sql`SELECT last_issued_session_seq FROM local_workout_sessions WHERE id = ${sessionId}`);
    expect(seq?.last_issued_session_seq).toBe(0);
  });

  it("CC01-LIFE-005: after Finish no set mutation is accepted and a repeated Finish issues no second command", async () => {
    const sessionId = await start();
    const completed = await repository.completeSet(setInput(sessionId));
    if (completed.status !== "COMPLETED") throw new Error("expected COMPLETED");
    await repository.finishWorkoutSession(sessionId);
    const commandsAfterFinish = count(connection, "sync_outbox");

    expect((await repository.completeSet(setInput(sessionId, { setOrder: 1, prescriptionSetId: "cc01-set-2" }))).status).toBe("SESSION_ALREADY_COMPLETED");
    expect((await repository.reopenSet(completed.result.performedSetId)).status).toBe("SESSION_ALREADY_COMPLETED");
    expect((await repository.finishWorkoutSession(sessionId)).status).toBe("ALREADY_FINISHED");

    expect(count(connection, "sync_outbox")).toBe(commandsAfterFinish);
  });

  it("CC01-LIFE-006: a second start while a session is active returns that session and issues nothing", async () => {
    const sessionId = await start();

    const second = await repository.startWorkoutSession(PRESCRIPTION);

    expect(second).toMatchObject({ status: "ALREADY_ACTIVE", session: { id: sessionId } });
    expect(count(connection, "sync_outbox")).toBe(1);
  });

  it("CC01-LIFE-007: Previous returns the last finished performance by exerciseRef, not the session in progress", async () => {
    const firstId = await start();
    await repository.completeSet(setInput(firstId, { actualReps: 11, actualLoad: ACTUAL_LOAD }));
    await repository.finishWorkoutSession(firstId);

    const secondId = await start();
    await repository.completeSet(setInput(secondId, { actualReps: 3 }));

    const previous = await repository.getPreviousExercisePerformance("bench-press", secondId);
    expect(previous).toEqual([{ order: 0, actualReps: 11, actualLoad: ACTUAL_LOAD }]);
  });

  it("CC01-LIFE-008: an orphaned SYNCING command from a dead process is picked up again, in original order", async () => {
    const sessionId = await start();
    await repository.completeSet(setInput(sessionId));
    const [oldest] = await repository.getPendingCommands(25);
    await repository.markSyncing(oldest!.commandId);

    connection.close();
    open();

    expect((await repository.getPendingCommands(25)).map((record) => record.commandId)[0]).toBe(oldest!.commandId);
  });

  it("CC01-PRESC-001: legacy normalization keeps exercise and set identity and every target value", () => {
    const legacy = JSON.parse(JSON.stringify(PRESCRIPTION)) as { exercises: { sets: { setType?: string }[] }[] };
    for (const exercise of legacy.exercises) for (const set of exercise.sets) delete set.setType;

    expect(normalizeStoredPrescription(legacy)).toEqual(PRESCRIPTION);
  });
});
