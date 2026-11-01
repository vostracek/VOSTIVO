import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDatabaseClient,
  performedExercises,
  performedSets,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { ensureProgressionEvaluateSessionQueues, PROGRESSION_EVALUATE_SESSION_QUEUE_V1 } from "@vostivo/progression-application";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { WorkoutCommandV1 } from "@vostivo/contracts";
import { processWorkoutCommand } from "./workout-command-processing.js";

/**
 * CC-01 Strength Regression Baseline — one complete lifecycle against real
 * Postgres and real pg-boss, then a full redelivery of every command. Existing
 * suites prove each command separately; this pins the end-to-end result.
 * Synthetic data only. `vitest.integration.setup.ts` refuses a dogfood target.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "cc01-server",
  name: "CC01 Server Day",
  exercises: [
    {
      prescriptionExerciseId: "cc01-ex-1",
      exerciseRef: "bench-press",
      displayName: "Bench Press",
      order: 0,
      sets: [
        {
          prescriptionSetId: "cc01-set-1",
          order: 0,
          targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
          targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
          restSeconds: 120,
          setType: "WORKING",
        },
      ],
    },
  ],
};

function lifecycleCommands(): WorkoutCommandV1[] {
  const base = { schemaVersion: 1 as const, createdAt: "2026-01-01T10:00:00.000Z" };
  const workoutSessionId = createEntityId();
  const performedExerciseId = createEntityId();
  const performedSetId = createEntityId();
  const complete = {
    ...base,
    type: "COMPLETE_SET_V1" as const,
    workoutSessionId,
    performedExerciseId,
    prescriptionExerciseId: "cc01-ex-1",
    exerciseRef: "bench-press",
    exerciseDisplayName: "Bench Press",
    exerciseOrder: 0,
    performedSetId,
    prescriptionSetId: "cc01-set-1",
    setOrder: 0,
    actualLoad: { kind: "EXTERNAL_WEIGHT" as const, amountMilli: 57500, unit: "KG" as const, basis: "TOTAL" as const },
    setType: "WORKING" as const,
    completedAt: "2026-01-01T10:05:00.000Z",
  };
  return [
    { ...base, commandId: createEntityId(), type: "START_WORKOUT_SESSION_V1", workoutSessionId, prescription: PRESCRIPTION, startedAt: "2026-01-01T10:00:00.000Z" },
    { ...complete, commandId: createEntityId(), actualReps: 7, revision: 1, sessionSeq: 1 },
    { ...base, commandId: createEntityId(), type: "REOPEN_SET_V1", performedSetId, revision: 2, sessionSeq: 2 },
    { ...complete, commandId: createEntityId(), actualReps: 9, revision: 3, sessionSeq: 3 },
    { ...base, commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", workoutSessionId, completedAt: "2026-01-01T10:30:00.000Z", finishSeq: 3 },
  ];
}

describe("CC-01 Strength lifecycle (real Postgres + real pg-boss)", () => {
  let db: Database;
  let boss: PgBoss;
  const userIds: string[] = [];

  beforeAll(async () => {
    if (DATABASE_URL === undefined) throw new Error("CC-01 requires an explicit DATABASE_URL, never a default target");
    db = createDatabaseClient(DATABASE_URL);
    boss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss.start();
    await ensureProgressionEvaluateSessionQueues(boss);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      const sessions = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds));
      const sessionIds = sessions.map((session) => session.id);
      await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, userIds));
      await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, userIds));
      if (sessionIds.length > 0) {
        const exercises = await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
        const exerciseIds = exercises.map((exercise) => exercise.id);
        if (exerciseIds.length > 0) await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
        await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
        await db.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
      }
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await boss.stop();
  });

  async function createUser(): Promise<string> {
    const id = createEntityId();
    await db.insert(users).values({ id, status: "ACTIVE" });
    userIds.push(id);
    return id;
  }

  async function queuedJobsFor(sessionId: string): Promise<number> {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${PROGRESSION_EVALUATE_SESSION_QUEUE_V1} AND data->>'workoutSessionId' = ${sessionId}`,
    );
    return rows[0]?.n ?? -1;
  }

  async function reality(sessionId: string) {
    const [session] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, sessionId));
    const exercises = await db.select().from(performedExercises).where(eq(performedExercises.workoutSessionId, sessionId));
    const sets = await db
      .select()
      .from(performedSets)
      .where(inArray(performedSets.performedExerciseId, exercises.map((exercise) => exercise.id)))
      .orderBy(asc(performedSets.orderIndex));
    return { session, exercises, sets };
  }

  it("CC01-SRV-001: one lifecycle converges on the final revision, keeps the snapshot and queues one evaluation", async () => {
    const userId = await createUser();
    const commands = lifecycleCommands();
    const sessionId = (commands[0] as { workoutSessionId: string }).workoutSessionId;

    const outcomes = [];
    for (const command of commands) outcomes.push((await processWorkoutCommand(db, boss, userId, command)).outcome);

    expect(outcomes).toEqual(["APPLIED", "APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
    const { session, exercises, sets } = await reality(sessionId);
    expect(session).toMatchObject({ userId, status: "COMPLETED", finishSeq: 3 });
    expect(session?.prescriptionSnapshot).toEqual(PRESCRIPTION);
    expect(exercises).toHaveLength(1);
    expect(exercises[0]).toMatchObject({ exerciseRef: "bench-press", prescriptionExerciseId: "cc01-ex-1" });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ actualReps: 9, loadAmountMilli: 57500, revision: 3, completionState: "COMPLETED", prescriptionSetId: "cc01-set-1" });
    expect(await queuedJobsFor(sessionId)).toBe(1);
  });

  it("CC01-SRV-002: redelivering every command twice is DUPLICATE and changes neither reality nor receipts nor jobs", async () => {
    const userId = await createUser();
    const commands = lifecycleCommands();
    const sessionId = (commands[0] as { workoutSessionId: string }).workoutSessionId;
    for (const command of commands) await processWorkoutCommand(db, boss, userId, command);
    const before = await reality(sessionId);
    const receiptsBefore = await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, userId));

    for (let delivery = 0; delivery < 2; delivery += 1) {
      for (const command of commands) {
        expect((await processWorkoutCommand(db, boss, userId, command)).outcome).toBe("DUPLICATE");
      }
    }

    expect(await reality(sessionId)).toEqual(before);
    expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, userId))).toEqual(receiptsBefore);
    expect(receiptsBefore).toHaveLength(commands.length);
    expect(await queuedJobsFor(sessionId)).toBe(1);
  });

  it("CC01-SRV-003: a delayed COMPLETE with an older revision cannot revert the converged set", async () => {
    const userId = await createUser();
    const [start, complete1, reopen, complete2, finish] = lifecycleCommands();
    const sessionId = (start as { workoutSessionId: string }).workoutSessionId;
    for (const command of [start!, complete2!, finish!]) await processWorkoutCommand(db, boss, userId, command);

    const late = [await processWorkoutCommand(db, boss, userId, complete1!), await processWorkoutCommand(db, boss, userId, reopen!)];

    expect(late.map((ack) => ack.outcome)).toEqual(["STALE", "STALE"]);
    expect((await reality(sessionId)).sets[0]).toMatchObject({ actualReps: 9, revision: 3, completionState: "COMPLETED" });
  });

  it("CC01-SRV-004: another athlete replaying the same commands reaches no data of the owner", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const commands = lifecycleCommands();
    const sessionId = (commands[0] as { workoutSessionId: string }).workoutSessionId;
    for (const command of commands) await processWorkoutCommand(db, boss, owner, command);
    const before = await reality(sessionId);

    for (const command of commands.slice(1)) await processWorkoutCommand(db, boss, stranger, command);

    expect(await reality(sessionId)).toEqual(before);
    expect((await reality(sessionId)).session?.userId).toBe(owner);
  });
});
