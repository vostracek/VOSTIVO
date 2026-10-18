import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { CompleteSetCommandV1, StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { processWorkoutCommand } from "./workout-command-processing.js";
import { ensureProgressionEvaluateSessionQueues, WorkoutHistoryService } from "@vostivo/progression-application";

/**
 * Real Postgres integration tests (Progression Prerequisites V1,
 * docs/domain/PROGRESSION-ENGINE-V1.md §29). Run via
 * `pnpm test:integration`, not part of the default `pnpm test` gate.
 *
 * Doubles as the lower-level round-trip proof that a WARM_UP set (1) can
 * exist in prescription/domain data, (2) can sync canonically via the
 * exact same command path as WORKING, (3) retains WARM_UP after the round
 * trip, and (4) is excluded from `getRecentWorkingExposures` — no hidden
 * production UI entry point was added solely to prove this.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

function buildPrescription(): WorkoutPrescriptionV1 {
  return {
    schemaVersion: 1,
    prescriptionId: "presc-history-test-1",
    name: "History Test Day",
    exercises: [
      {
        prescriptionExerciseId: "presc-ex-1",
        exerciseRef: "history-test-bench-press",
        displayName: "Bench Press",
        order: 0,
        sets: [
          { prescriptionSetId: "presc-set-warmup", order: 0, targetReps: { kind: "EXACT", reps: 5 }, targetLoad: null, restSeconds: null, setType: "WARM_UP" },
          { prescriptionSetId: "presc-set-1", order: 1, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: null, restSeconds: null, setType: "WORKING" },
        ],
      },
    ],
  };
}

function startCommand(workoutSessionId: string, prescription: WorkoutPrescriptionV1): StartWorkoutSessionCommandV1 {
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    prescription,
    startedAt: new Date().toISOString(),
  };
}

function completeCommand(
  workoutSessionId: string,
  overrides: Partial<CompleteSetCommandV1> = {},
): CompleteSetCommandV1 {
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    performedExerciseId: createEntityId(),
    prescriptionExerciseId: "presc-ex-1",
    exerciseRef: "history-test-bench-press",
    exerciseDisplayName: "Bench Press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: "presc-set-1",
    setOrder: 1,
    actualReps: 10,
    actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
    setType: "WORKING",
    revision: 1,
    completedAt: new Date().toISOString(),
    sessionSeq: 1,
    ...overrides,
  };
}

describe("WorkoutHistoryService.getRecentWorkingExposures (real Postgres)", () => {
  let db: Database;
  let userId: string;
  let otherUserId: string;
  // Progression Evaluation Orchestration V1: `processWorkoutCommand` (used
  // here to build real canonical evidence) now enqueues a durable pg-boss
  // job transactionally — a real, started producer instance.
  let testBoss: PgBoss;

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    testBoss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await testBoss.start();
    await ensureProgressionEvaluateSessionQueues(testBoss);
  });

  afterAll(async () => {
    await testBoss.stop();
  });

  beforeEach(async () => {
    userId = createEntityId();
    otherUserId = createEntityId();
    await db.insert(users).values([
      { id: userId, status: "ACTIVE" },
      { id: otherUserId, status: "ACTIVE" },
    ]);
  });

  async function cleanup(): Promise<void> {
    const sessions = await db
      .select({ id: workoutSessions.id })
      .from(workoutSessions)
      .where(inArray(workoutSessions.userId, [userId, otherUserId]));
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      const exercises = await db
        .select({ id: performedExercises.id })
        .from(performedExercises)
        .where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exercises.map((e) => e.id);
      if (exerciseIds.length > 0) {
        await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
      }
      await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
    }
    await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, [userId, otherUserId]));
    // Keyed by userId, not workoutSessionId — START/FINISH receipts carry
    // a null workoutSessionId (see workout-command-processing.ts's
    // sessionSeqFor/applyMutation), so filtering by session id alone
    // would leave those rows behind, still referencing the user.
    await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, [userId, otherUserId]));
    await db.delete(workoutSessions).where(inArray(workoutSessions.userId, [userId, otherUserId]));
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  }

  it("PROG-PREREQ-HIST-001: returns only WORKING exposures for the exact exerciseRef, excluding WARM_UP", async () => {
    const workoutSessionId = createEntityId();
    const prescription = buildPrescription();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, prescription));

    const performedExerciseId = createEntityId();
    // WARM_UP set — same exercise, same session.
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, {
        performedExerciseId,
        performedSetId: createEntityId(),
        prescriptionSetId: "presc-set-warmup",
        setOrder: 0,
        actualReps: 5,
        actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 20000, unit: "KG", basis: "TOTAL" },
        setType: "WARM_UP",
        sessionSeq: 1,
      }),
    );
    // WORKING set — same exercise, same session.
    const workingSetId = createEntityId();
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, {
        performedExerciseId,
        performedSetId: workingSetId,
        setType: "WORKING",
        sessionSeq: 2,
      }),
    );

    const service = new WorkoutHistoryService(db);
    const exposures = await service.getRecentWorkingExposures({ userId }, "history-test-bench-press");

    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.performedSetId).toBe(workingSetId);
    expect(exposures[0]?.setType).toBe("WORKING");
    // The WARM_UP round trip proof: it exists (it was APPLIED above,
    // proven by not throwing / by the receipts table below), it is real
    // canonical history, and it is correctly excluded here — never
    // silently dropped from the database, only from this evidence read.
    const receipts = await db
      .select({ commandType: workoutCommandReceipts.commandType, outcome: workoutCommandReceipts.outcome })
      .from(workoutCommandReceipts)
      .where(eq(workoutCommandReceipts.workoutSessionId, workoutSessionId));
    expect(receipts.filter((r) => r.commandType === "COMPLETE_SET_V1" && r.outcome === "APPLIED")).toHaveLength(2);

    await cleanup();
  });

  it("PROG-PREREQ-HIST-002: never returns another user's history (BOLA)", async () => {
    const workoutSessionId = createEntityId();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, buildPrescription()));
    await processWorkoutCommand(db, testBoss, userId, completeCommand(workoutSessionId));

    const service = new WorkoutHistoryService(db);
    const asOwner = await service.getRecentWorkingExposures({ userId }, "history-test-bench-press");
    const asOther = await service.getRecentWorkingExposures({ userId: otherUserId }, "history-test-bench-press");

    expect(asOwner).toHaveLength(1);
    expect(asOther).toHaveLength(0);

    await cleanup();
  });

  it("PROG-PREREQ-HIST-003: never matches a different exerciseRef", async () => {
    const workoutSessionId = createEntityId();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, buildPrescription()));
    await processWorkoutCommand(db, testBoss, userId, completeCommand(workoutSessionId));

    const service = new WorkoutHistoryService(db);
    const wrongRef = await service.getRecentWorkingExposures({ userId }, "some-other-exercise");

    expect(wrongRef).toHaveLength(0);

    await cleanup();
  });

  it("PROG-PREREQ-HIST-004: respects a bounded limit and orders most-recent-first", async () => {
    const workoutSessionId = createEntityId();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, buildPrescription()));

    const performedExerciseId = createEntityId();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const performedSetId = createEntityId();
      ids.push(performedSetId);
      await processWorkoutCommand(
        db, testBoss,
        userId,
        completeCommand(workoutSessionId, {
          performedExerciseId,
          performedSetId,
          prescriptionSetId: null, // extra sets beyond the fixture's one prescribed WORKING slot — still real history
          setOrder: i + 2,
          sessionSeq: i + 2,
        }),
      );
    }

    const service = new WorkoutHistoryService(db);
    const bounded = await service.getRecentWorkingExposures({ userId }, "history-test-bench-press", 3);
    expect(bounded).toHaveLength(3);
    // Most recent (last completed) first.
    expect(bounded[0]?.performedSetId).toBe(ids[4]);

    await cleanup();
  });
});
