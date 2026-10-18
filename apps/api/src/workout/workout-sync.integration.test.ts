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
import { ensureProgressionEvaluateSessionQueues, PROGRESSION_EVALUATE_SESSION_QUEUE_V1 } from "@vostivo/progression-application";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type {
  CompleteSetCommandV1,
  FinishWorkoutSessionCommandV1,
  ReopenSetCommandV1,
  StartWorkoutSessionCommandV1,
} from "@vostivo/contracts";
import { processWorkoutCommand } from "./workout-command-processing.js";

/**
 * Real Postgres integration tests (spec section 35/45) — never a real
 * Supabase project. Run via `pnpm test:integration`, not part of the
 * default `pnpm test` gate (spec section 16 precedent).
 *
 * Covers the server-side WDI-SYNC requirements. WDI-SYNC-009 (temporary
 * failure stays retryable) and WDI-SYNC-010 (rejected command preserves
 * local data) are properties of the *mobile* client/local-repository, not
 * the server — see apps/mobile's sync-engine and workout-repository
 * tests for those.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TEST_PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "presc-test-1",
  name: "Test Push Day",
  exercises: [
    {
      prescriptionExerciseId: "presc-ex-1",
      exerciseRef: null,
      displayName: "Barbell Bench Press",
      order: 0,
      sets: [{ prescriptionSetId: "presc-set-1", order: 0, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: null, setType: "WORKING" }],
    },
  ],
};

function startCommand(overrides: Partial<StartWorkoutSessionCommandV1> = {}): StartWorkoutSessionCommandV1 {
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId: createEntityId(),
    prescription: TEST_PRESCRIPTION,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function finishCommand(
  workoutSessionId: string,
  overrides: Partial<FinishWorkoutSessionCommandV1> = {},
): FinishWorkoutSessionCommandV1 {
  return {
    commandId: createEntityId(),
    type: "FINISH_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    completedAt: new Date().toISOString(),
    // Defaults to "no set mutation was ever issued" — tests with a prior
    // COMPLETE_SET_V1/REOPEN_SET_V1 must override this to that command's
    // own sessionSeq (or higher) to represent an honest causal story.
    finishSeq: 0,
    ...overrides,
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
    exerciseRef: "bench-press",
    exerciseDisplayName: "Barbell Bench Press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: "presc-set-1",
    setOrder: 0,
    actualReps: 10,
    actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 40000, unit: "KG", basis: "PER_IMPLEMENT" },
    setType: "WORKING",
    revision: 1,
    completedAt: new Date().toISOString(),
    sessionSeq: 1,
    ...overrides,
  };
}

function reopenCommand(
  performedSetId: string,
  overrides: Partial<ReopenSetCommandV1> = {},
): ReopenSetCommandV1 {
  return {
    commandId: createEntityId(),
    type: "REOPEN_SET_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    performedSetId,
    revision: 2,
    sessionSeq: 2,
    ...overrides,
  };
}

describe("workout sync — server-side (real Postgres)", () => {
  let db: Database;
  // Progression Evaluation Orchestration V1: `processWorkoutCommand` now
  // enqueues a durable pg-boss job transactionally on FINISH/post-Finish
  // evidence changes — a real, started producer instance (never a mock),
  // matching this suite's "real Postgres, no fakes" convention throughout.
  let testBoss: PgBoss;
  const testUserIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    testBoss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await testBoss.start();
    await ensureProgressionEvaluateSessionQueues(testBoss);
  });

  afterAll(async () => {
    await cleanup(db, testUserIds);
    await testBoss.stop();
  });

  async function createTestUser(): Promise<string> {
    const id = createEntityId();
    await db.insert(users).values({ id, status: "ACTIVE" });
    testUserIds.push(id);
    return id;
  }

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  it("WDI-SYNC-001 / WDI-006: first START command creates one canonical session with the client's UUIDv7 id", async () => {
    const userId = await createTestUser();
    const command = startCommand();

    const ack = await processWorkoutCommand(db, testBoss, userId, command);

    expect(ack.outcome).toBe("APPLIED");
    expect(command.workoutSessionId).toMatch(UUID_V7_PATTERN);

    const [row] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, command.workoutSessionId));
    expect(row?.id).toBe(command.workoutSessionId); // server never regenerates the id
    expect(row?.userId).toBe(userId);
    expect(row?.status).toBe("ACTIVE");
  });

  it("WDI-SYNC-002: duplicate START command (same commandId) is idempotent — one session, DUPLICATE ack", async () => {
    const userId = await createTestUser();
    const command = startCommand();

    const first = await processWorkoutCommand(db, testBoss, userId, command);
    const second = await processWorkoutCommand(db, testBoss, userId, command);

    expect(first.outcome).toBe("APPLIED");
    expect(second.outcome).toBe("DUPLICATE");

    const rows = await db.select().from(workoutSessions).where(eq(workoutSessions.id, command.workoutSessionId));
    expect(rows).toHaveLength(1);
  });

  it("WDI-SYNC-003: COMPLETE_SET_V1 produces canonical performed reality with correct load semantics", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const complete = completeCommand(start.workoutSessionId);
    const ack = await processWorkoutCommand(db, testBoss, userId, complete);

    expect(ack.outcome).toBe("APPLIED");
    expect(complete.performedSetId).toMatch(UUID_V7_PATTERN);

    const [set] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(set?.actualReps).toBe(10);
    expect(set?.loadAmountMilli).toBe(40000);
    expect(set?.loadUnit).toBe("KG");
    expect(set?.loadBasis).toBe("PER_IMPLEMENT"); // never summed to TOTAL (LOAD-INV-005)
    expect(set?.completionState).toBe("COMPLETED");
    expect(set?.revision).toBe(1);

    const [exercise] = await db
      .select()
      .from(performedExercises)
      .where(eq(performedExercises.id, complete.performedExerciseId));
    expect(exercise?.workoutSessionId).toBe(start.workoutSessionId);
  });

  it("WDI-SYNC-011: performed reality stays bound to the session snapshot — no identity change, no foreign/removed set, no re-pointed exercise", async () => {
    const userId = await createTestUser();
    const prescription: WorkoutPrescriptionV1 = {
      ...TEST_PRESCRIPTION,
      exercises: [{ ...TEST_PRESCRIPTION.exercises[0]!, exerciseRef: "bench-press" }],
    };
    const start = startCommand({ prescription });
    await processWorkoutCommand(db, testBoss, userId, start);
    const sessionId = start.workoutSessionId;

    const rejected: Partial<CompleteSetCommandV1>[] = [
      { exerciseRef: "dumbbell-bench-press" }, // identity change after START
      { prescriptionSetId: "presc-set-removed" }, // a set the snapshot does not contain (e.g. Available-Time removed it)
      { prescriptionExerciseId: "presc-ex-unknown" }, // a slot the snapshot does not contain
      { prescriptionExerciseId: null }, // an unplanned exercise cannot claim a planned set
    ];
    for (const [index, overrides] of rejected.entries()) {
      const ack = await processWorkoutCommand(db, testBoss, userId, completeCommand(sessionId, { sessionSeq: index + 1, ...overrides }));
      expect(ack.outcome, JSON.stringify(overrides)).toBe("REJECTED");
    }
    expect(await db.select().from(performedExercises).where(eq(performedExercises.workoutSessionId, sessionId))).toHaveLength(0);

    const valid = completeCommand(sessionId, { sessionSeq: 10 });
    expect((await processWorkoutCommand(db, testBoss, userId, valid)).outcome).toBe("APPLIED");
    // The same performed exercise cannot be re-pointed at another slot by a later set.
    const repointed = completeCommand(sessionId, { sessionSeq: 11, performedExerciseId: valid.performedExerciseId, prescriptionExerciseId: null, prescriptionSetId: null });
    expect((await processWorkoutCommand(db, testBoss, userId, repointed)).outcome).toBe("REJECTED");
    // An unplanned exercise without planned set ids is still accepted.
    const unplanned = completeCommand(sessionId, { sessionSeq: 12, prescriptionExerciseId: null, prescriptionSetId: null, exerciseRef: "face-pull" });
    expect((await processWorkoutCommand(db, testBoss, userId, unplanned)).outcome).toBe("APPLIED");

    const performed = await db.select().from(performedExercises).where(eq(performedExercises.workoutSessionId, sessionId));
    expect(performed.map((e) => [e.prescriptionExerciseId, e.exerciseRef]).sort()).toEqual([["presc-ex-1", "bench-press"], [null, "face-pull"]].sort());
    const sets = await db.select().from(performedSets).where(inArray(performedSets.performedExerciseId, performed.map((e) => e.id)));
    expect(sets.map((s) => s.prescriptionSetId).sort()).toEqual(["presc-set-1", null].sort());
  });

  it("WDI-SYNC-004 / simulated lost ACK (spec section 40): duplicate COMPLETE command produces zero duplicate rows", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const complete = completeCommand(start.workoutSessionId);

    const first = await processWorkoutCommand(db, testBoss, userId, complete);
    // Client behaves as if the ACK for `first` was lost and retries the
    // *exact same* command (same commandId) again.
    const retry = await processWorkoutCommand(db, testBoss, userId, complete);

    expect(first.outcome).toBe("APPLIED");
    expect(retry.outcome).toBe("DUPLICATE");

    const setRows = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(setRows).toHaveLength(1);

    const cursorRows = await db
      .select()
      .from(workoutChangeCursor)
      .where(eq(workoutChangeCursor.resourceId, complete.performedSetId));
    expect(cursorRows).toHaveLength(1); // no duplicate side effect (cursor entry) either
  });

  it("WDI-SYNC-006 / out-of-order test (spec section 41): a stale redelivered COMPLETE cannot revert a newer REOPEN", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const complete = completeCommand(start.workoutSessionId, { revision: 1 });
    const completeAck = await processWorkoutCommand(db, testBoss, userId, complete);
    expect(completeAck.outcome).toBe("APPLIED");

    const reopen = reopenCommand(complete.performedSetId, { revision: 2, sessionSeq: 2 });
    const reopenAck = await processWorkoutCommand(db, testBoss, userId, reopen);
    expect(reopenAck.outcome).toBe("APPLIED");

    // A genuinely separate, later/redelivered attempt to (re-)apply the
    // original revision 1 COMPLETE for the same set — must be recognized
    // as stale and must NOT revert the now-REOPENED state (spec section 17).
    // A different commandId, so it must get its own sessionSeq (3, after
    // complete=1 and reopen=2) — reusing seq 1 here would (correctly)
    // collide with the DB-level sessionSeq uniqueness guarantee instead
    // of exercising the revision gate this test targets (see AW-ORDER-007
    // below for that guarantee's own dedicated test).
    const staleRedelivery = completeCommand(start.workoutSessionId, {
      commandId: createEntityId(),
      performedExerciseId: complete.performedExerciseId,
      performedSetId: complete.performedSetId,
      revision: 1,
      sessionSeq: 3,
    });
    const staleAck = await processWorkoutCommand(db, testBoss, userId, staleRedelivery);
    expect(staleAck.outcome).toBe("STALE");

    const [finalSet] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(finalSet?.completionState).toBe("REOPENED"); // not reverted to COMPLETED
    expect(finalSet?.revision).toBe(2);
  });

  it("WDI-SYNC-007: malformed load semantics are rejected safely, without touching canonical data", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const badCommand = completeCommand(start.workoutSessionId, {
      actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 40000, unit: "STONE" as never, basis: "TOTAL" },
    });

    const ack = await processWorkoutCommand(db, testBoss, userId, badCommand);
    expect(ack.outcome).toBe("REJECTED");

    const rows = await db.select().from(performedSets).where(eq(performedSets.id, badCommand.performedSetId));
    expect(rows).toHaveLength(0);
  });

  it("WDI-SYNC-008 / BOLA: athlete B cannot complete or reopen athlete A's set", async () => {
    const athleteA = await createTestUser();
    const athleteB = await createTestUser();

    const start = startCommand();
    await processWorkoutCommand(db, testBoss, athleteA, start);
    const complete = completeCommand(start.workoutSessionId);
    await processWorkoutCommand(db, testBoss, athleteA, complete);

    const bTriesToCompleteInAsSession = await processWorkoutCommand(
      db, testBoss,
      athleteB,
      completeCommand(start.workoutSessionId),
    );
    expect(bTriesToCompleteInAsSession.outcome).toBe("REJECTED");

    const bTriesToReopenASet = await processWorkoutCommand(db, testBoss, athleteB, reopenCommand(complete.performedSetId));
    expect(bTriesToReopenASet.outcome).toBe("REJECTED");

    // Athlete A's data is untouched by B's rejected attempts.
    const [setRow] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(setRow?.completionState).toBe("COMPLETED");
    expect(setRow?.revision).toBe(1);
  });

  it("AW-SYNC-001: FINISH_WORKOUT_SESSION_V1 completes the canonical session", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const finish = finishCommand(start.workoutSessionId);
    const ack = await processWorkoutCommand(db, testBoss, userId, finish);

    expect(ack.outcome).toBe("APPLIED");
    const [row] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    expect(row?.status).toBe("COMPLETED");
    expect(row?.completedAt).not.toBeNull();
  });

  it("AW-SYNC-002: a duplicate FINISH command (same commandId) is idempotent", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const finish = finishCommand(start.workoutSessionId);

    const first = await processWorkoutCommand(db, testBoss, userId, finish);
    const second = await processWorkoutCommand(db, testBoss, userId, finish);

    expect(first.outcome).toBe("APPLIED");
    expect(second.outcome).toBe("DUPLICATE");
    const [row] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    expect(row?.status).toBe("COMPLETED");
  });

  it("AW-SYNC-003 / BOLA: athlete B cannot finish athlete A's session", async () => {
    const athleteA = await createTestUser();
    const athleteB = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, athleteA, start);

    const ack = await processWorkoutCommand(db, testBoss, athleteB, finishCommand(start.workoutSessionId));
    expect(ack.outcome).toBe("REJECTED");

    const [row] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    expect(row?.status).toBe("ACTIVE"); // untouched by the rejected attempt
  });

  it("AW-SYNC-004 / AW-SYNC-005: a FINISH command applied later (simulating a delayed sync) still converges canonical state", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const complete = completeCommand(start.workoutSessionId);
    await processWorkoutCommand(db, testBoss, userId, complete);

    // The local device finished the workout and queued the command while
    // offline; this call represents the retry succeeding once the API
    // becomes reachable again — no different code path, same function.
    const ack = await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 1 }));

    expect(ack.outcome).toBe("APPLIED");
    const [row] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    expect(row?.status).toBe("COMPLETED");
  });

  it("AW-SYNC-006: finishing a session never removes performed sets or history", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const complete = completeCommand(start.workoutSessionId);
    await processWorkoutCommand(db, testBoss, userId, complete);

    await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 1 }));

    const setRows = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(setRows).toHaveLength(1);
    expect(setRows[0]?.completionState).toBe("COMPLETED");
  });

  it("AW-SYNC-007: COMPLETE_SET(r1) -> REOPEN_SET(r2) -> FINISH, applied in that exact order, converges correctly", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const complete = completeCommand(start.workoutSessionId, { revision: 1 });
    const completeAck = await processWorkoutCommand(db, testBoss, userId, complete);
    expect(completeAck.outcome).toBe("APPLIED");

    const reopen = reopenCommand(complete.performedSetId, { revision: 2, sessionSeq: 2 });
    const reopenAck = await processWorkoutCommand(db, testBoss, userId, reopen);
    expect(reopenAck.outcome).toBe("APPLIED");

    const finishAck = await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 2 }));
    expect(finishAck.outcome).toBe("APPLIED");

    const [session] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    const [setRow] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(session?.status).toBe("COMPLETED");
    expect(setRow?.completionState).toBe("REOPENED"); // FINISH never touches set-level reality
    expect(setRow?.revision).toBe(2);
  });

  it("AW-SYNC-008: a late COMPLETE_SET/REOPEN_SET arriving AFTER FINISH still applies — FINISH is not a set-level lock, and set-level commands are order-independent by revision, not by session status", async () => {
    // Local mutations are strictly ordered on-device (one SQLite
    // connection), but the mobile SyncEngine fires a sync call after each
    // mutation without awaiting the previous one (spec: "verify command
    // ordering around Finish") — so the corresponding HTTP requests can
    // reach the server out of the order they were enqueued in. This proves
    // the server-side outcome is correct regardless: neither
    // applyCompleteSet nor applyReopenSet gates on workoutSessions.status,
    // by design — a session being COMPLETED records that the athlete
    // finished, it does not retroactively lock out a genuinely-earlier
    // local mutation whose own sync request simply took longer in flight.
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    // FINISH's HTTP round trip "wins the race" and reaches the server first.
    // finishSeq: 1 — the client's own local Finish already knew this
    // COMPLETE_SET_V1 (sessionSeq 1) had been issued before it finished;
    // it is eligible, not a genuinely new post-Finish mutation.
    const finishAck = await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 1 }));
    expect(finishAck.outcome).toBe("APPLIED");

    // The COMPLETE_SET_V1 that causally happened first on-device arrives late.
    const complete = completeCommand(start.workoutSessionId, { revision: 1 });
    const completeAck = await processWorkoutCommand(db, testBoss, userId, complete);
    expect(completeAck.outcome).toBe("APPLIED");

    const [session] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    const [setRow] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(session?.status).toBe("COMPLETED"); // untouched by the late set command
    expect(setRow?.completionState).toBe("COMPLETED"); // still recorded, not dropped or rejected
    expect(setRow?.revision).toBe(1);
  });

  it("AW-ORDER-001: COMPLETE(seq1) delivered after FINISH(finishSeq1) — a pre-Finish command delivered late — still applies", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const finishAck = await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 1 }));
    expect(finishAck.outcome).toBe("APPLIED");

    const complete = completeCommand(start.workoutSessionId, { revision: 1, sessionSeq: 1 });
    const completeAck = await processWorkoutCommand(db, testBoss, userId, complete);
    expect(completeAck.outcome).toBe("APPLIED");
  });

  it("AW-ORDER-002: COMPLETE(seq1) + REOPEN(seq2) delivered after FINISH(finishSeq2) converge per existing revision semantics — no valid reality lost", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    // Delivery: FINISH arrives first (finishSeq=2, since on-device both
    // the complete and reopen below were already issued before Finish).
    const finishAck = await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 2 }));
    expect(finishAck.outcome).toBe("APPLIED");

    // A REOPEN for a set that hasn't been created yet is REJECTED outright
    // — a pre-existing referential constraint independent of the Finish
    // causal boundary (REOPEN always requires its target COMPLETE to
    // already exist, Finish or not). No corruption results either way.
    const prematureReopen = reopenCommand(createEntityId(), { sessionSeq: 2 });
    const prematureReopenAck = await processWorkoutCommand(db, testBoss, userId, prematureReopen);
    expect(prematureReopenAck.outcome).toBe("REJECTED");

    // COMPLETE(seq1) arrives next — eligible (1 <= 2) — applies normally.
    const complete = completeCommand(start.workoutSessionId, { revision: 1, sessionSeq: 1 });
    const completeAck = await processWorkoutCommand(db, testBoss, userId, complete);
    expect(completeAck.outcome).toBe("APPLIED");

    // Now REOPEN(seq2) for the set that exists — eligible (2 <= 2) —
    // applies per the ordinary revision gate, same as always.
    const reopen = reopenCommand(complete.performedSetId, { revision: 2, sessionSeq: 2 });
    const reopenAck = await processWorkoutCommand(db, testBoss, userId, reopen);
    expect(reopenAck.outcome).toBe("APPLIED");

    const [session] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId));
    const [setRow] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(session?.status).toBe("COMPLETED");
    expect(setRow?.completionState).toBe("REOPENED");
    expect(setRow?.revision).toBe(2);
  });

  it("AW-ORDER-005: a new command with sessionSeq beyond the session's finishSeq is REJECTED as a post-Finish mutation", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 3 }));

    const postFinishComplete = completeCommand(start.workoutSessionId, { sessionSeq: 4 });
    const ack = await processWorkoutCommand(db, testBoss, userId, postFinishComplete);
    expect(ack.outcome).toBe("REJECTED");

    const rows = await db.select().from(performedSets).where(eq(performedSets.id, postFinishComplete.performedSetId));
    expect(rows).toHaveLength(0); // never applied
  });

  it("AW-ORDER-006: a late command with sessionSeq at or below the session's finishSeq is eligible for normal processing", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 3 }));

    const lateComplete = completeCommand(start.workoutSessionId, { sessionSeq: 2 });
    const ack = await processWorkoutCommand(db, testBoss, userId, lateComplete);
    expect(ack.outcome).toBe("APPLIED");
  });

  it("AW-ORDER-007: two different commands cannot claim the same (session, sessionSeq) — DB-level uniqueness rejects the second", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const first = completeCommand(start.workoutSessionId, { sessionSeq: 1 });
    const firstAck = await processWorkoutCommand(db, testBoss, userId, first);
    expect(firstAck.outcome).toBe("APPLIED");

    // A different commandId AND a different performedSetId, but reusing
    // sessionSeq=1 — simulates a buggy client that failed to advance its
    // local sequence counter.
    const second = completeCommand(start.workoutSessionId, { sessionSeq: 1 });
    const secondAck = await processWorkoutCommand(db, testBoss, userId, second);
    expect(secondAck.outcome).toBe("REJECTED");

    // The second command's mutation was fully rolled back, not partially applied.
    const secondRows = await db.select().from(performedSets).where(eq(performedSets.id, second.performedSetId));
    expect(secondRows).toHaveLength(0);
    // The first command's data is untouched.
    const firstRows = await db.select().from(performedSets).where(eq(performedSets.id, first.performedSetId));
    expect(firstRows).toHaveLength(1);
  });

  it("AW-ORDER-008: duplicate delivery of the same commandId (and therefore the same sessionSeq) remains idempotent", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);

    const complete = completeCommand(start.workoutSessionId, { sessionSeq: 1 });
    const first = await processWorkoutCommand(db, testBoss, userId, complete);
    const retry = await processWorkoutCommand(db, testBoss, userId, complete); // exact same command, same commandId

    expect(first.outcome).toBe("APPLIED");
    expect(retry.outcome).toBe("DUPLICATE");

    const rows = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(rows).toHaveLength(1);
  });
});

/**
 * Progression Evaluation Orchestration V1 — direct proof (real Postgres +
 * real pg-boss) that `processWorkoutCommand` enqueues a durable
 * `progression-evaluate-session-v1` job at exactly the right moments, with
 * the minimal, non-sensitive payload, and never at any other moment. The
 * commit/rollback ATOMICITY of the enqueue mechanism itself is proven
 * separately (`packages/progression-application`'s
 * `progression-queue.integration.test.ts`) — this suite proves the
 * INTEGRATION POINT: which real WDI commands trigger it.
 */
describe("Progression Evaluation Orchestration V1 — durable enqueue on FINISH / post-Finish evidence changes (real Postgres + real pg-boss)", () => {
  let db: Database;
  let testBoss: PgBoss;
  const testUserIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    testBoss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await testBoss.start();
    await ensureProgressionEvaluateSessionQueues(testBoss);
  });

  afterAll(async () => {
    await cleanup(db, testUserIds);
    await testBoss.stop();
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  async function createTestUser(): Promise<string> {
    const id = createEntityId();
    await db.insert(users).values({ id, status: "ACTIVE" });
    testUserIds.push(id);
    return id;
  }

  async function jobsFor(workoutSessionId: string) {
    return testBoss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { data: { workoutSessionId } });
  }

  it("a genuine ACTIVE -> COMPLETED FINISH transition enqueues exactly one job with the minimal, non-sensitive payload", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const finish = finishCommand(start.workoutSessionId);

    await processWorkoutCommand(db, testBoss, userId, finish);

    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ workoutSessionId: start.workoutSessionId, triggerCommandId: finish.commandId });
  });

  it("a duplicate FINISH (same commandId, receipt short-circuit) never enqueues a second job", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const finish = finishCommand(start.workoutSessionId);

    await processWorkoutCommand(db, testBoss, userId, finish);
    await processWorkoutCommand(db, testBoss, userId, finish); // exact same commandId

    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(1);
  });

  it("a second, DISTINCT-commandId FINISH against an already-COMPLETED session (the watermark never moves twice) does not enqueue another job", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const firstFinish = finishCommand(start.workoutSessionId);
    await processWorkoutCommand(db, testBoss, userId, firstFinish);

    const secondFinish = finishCommand(start.workoutSessionId); // distinct commandId, same session
    const ack = await processWorkoutCommand(db, testBoss, userId, secondFinish);
    expect(ack.outcome).toBe("APPLIED"); // idempotent no-op per WDI-SYNC semantics

    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(1); // still just the one from the genuine transition
  });

  it("COMPLETE_SET_V1 against a still-ACTIVE session never enqueues a job — evaluated once at FINISH, not per set", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    await processWorkoutCommand(db, testBoss, userId, completeCommand(start.workoutSessionId, { sessionSeq: 1 }));

    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(0);
  });

  it("a late-but-causally-valid COMPLETE_SET_V1 against an ALREADY-COMPLETED session enqueues a re-evaluation job", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    // finishSeq=2 reserves seq 2 for the not-yet-delivered late COMPLETE_SET below.
    await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 2 }));

    const lateComplete = completeCommand(start.workoutSessionId, { sessionSeq: 2 });
    const ack = await processWorkoutCommand(db, testBoss, userId, lateComplete);
    expect(ack.outcome).toBe("APPLIED");

    // Two genuine triggers occurred in this scenario: the FINISH transition
    // itself, and the late correction — both correctly schedule their own
    // re-evaluation job.
    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => (j.data as { triggerCommandId: string }).triggerCommandId)).toEqual(
      expect.arrayContaining([lateComplete.commandId]),
    );
  });

  it("a REJECTED post-Finish mutation attempt (sessionSeq beyond finishSeq) never enqueues its OWN job — only the FINISH transition's", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const finish = finishCommand(start.workoutSessionId, { finishSeq: 1 });
    await processWorkoutCommand(db, testBoss, userId, finish);

    const rejected = completeCommand(start.workoutSessionId, { sessionSeq: 5 }); // beyond finishSeq -> REJECTED
    const ack = await processWorkoutCommand(db, testBoss, userId, rejected);
    expect(ack.outcome).toBe("REJECTED");

    // Only the FINISH transition's own job — the rejected command contributed none.
    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ workoutSessionId: start.workoutSessionId, triggerCommandId: finish.commandId });
  });

  it("a late-but-causally-valid REOPEN_SET_V1 against an ALREADY-COMPLETED session also enqueues a re-evaluation job", async () => {
    const userId = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, userId, start);
    const complete = completeCommand(start.workoutSessionId, { sessionSeq: 1 });
    await processWorkoutCommand(db, testBoss, userId, complete);
    // finishSeq=3 reserves seq 2/3 for the not-yet-delivered reopen below.
    await processWorkoutCommand(db, testBoss, userId, finishCommand(start.workoutSessionId, { finishSeq: 3 }));

    const lateReopen = reopenCommand(complete.performedSetId, { revision: 2, sessionSeq: 2 });
    const ack = await processWorkoutCommand(db, testBoss, userId, lateReopen);
    expect(ack.outcome).toBe("APPLIED");

    // The FINISH transition's own job, plus the late REOPEN's.
    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => (j.data as { triggerCommandId: string }).triggerCommandId)).toEqual(
      expect.arrayContaining([lateReopen.commandId]),
    );
  });

  it("a BOLA-rejected FINISH (wrong owner) never enqueues a job", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const start = startCommand();
    await processWorkoutCommand(db, testBoss, owner, start);

    const ack = await processWorkoutCommand(db, testBoss, attacker, finishCommand(start.workoutSessionId));
    expect(ack.outcome).toBe("REJECTED");

    const jobs = await jobsFor(start.workoutSessionId);
    expect(jobs).toHaveLength(0);
  });
});

async function cleanup(db: Database, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  const sessions = await db
    .select({ id: workoutSessions.id })
    .from(workoutSessions)
    .where(inArray(workoutSessions.userId, userIds));
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

  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, userIds));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, userIds));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}
