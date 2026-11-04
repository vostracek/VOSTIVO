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
import type { CompleteSetCommandV1, StartWorkoutSessionCommandV1, WorkoutCommandV1 } from "@vostivo/contracts";
import { processWorkoutCommand } from "./workout-command-processing.js";
import { WorkoutSyncService } from "./workout-sync.service.js";
import type { SyncWorkoutCommandsRequestDto } from "./dto/workout-command.dto.js";
import { requireDisposableDatabaseUrl } from "../../../../packages/test-fixtures/src/assert-disposable-test-database.js";

/**
 * CORE-FIX-01 (CORE-AUDIT-01 F-01) — a COMPLETE_SET_V1 must never overwrite
 * an existing performed set that is not the command's own set: another
 * athlete's set, or the same athlete's set in another session / under
 * another performed exercise. Real Postgres + real pg-boss, disposable DB only.
 */
const DATABASE_URL = requireDisposableDatabaseUrl("DATABASE_URL");

const PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "presc-ownership-1",
  name: "Ownership Push Day",
  exercises: [
    {
      prescriptionExerciseId: "presc-ex-1",
      exerciseRef: null,
      displayName: "Barbell Bench Press",
      order: 0,
      sets: [
        { prescriptionSetId: "presc-set-1", order: 0, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: null, setType: "WORKING" },
        { prescriptionSetId: "presc-set-2", order: 1, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: null, setType: "WORKING" },
      ],
    },
    {
      prescriptionExerciseId: "presc-ex-2",
      exerciseRef: null,
      displayName: "Overhead Press",
      order: 1,
      sets: [{ prescriptionSetId: "presc-set-3", order: 0, targetReps: { kind: "EXACT", reps: 8 }, targetLoad: null, restSeconds: null, setType: "WORKING" }],
    },
  ],
};

function startCommand(): StartWorkoutSessionCommandV1 {
  const now = new Date().toISOString();
  return { commandId: createEntityId(), type: "START_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: now, workoutSessionId: createEntityId(), prescription: PRESCRIPTION, startedAt: now };
}

function completeCommand(workoutSessionId: string, overrides: Partial<CompleteSetCommandV1> = {}): CompleteSetCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: now,
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
    completedAt: now,
    sessionSeq: 1,
    ...overrides,
  };
}

/** A hostile overwrite payload: every reality field differs from the victim's set, newer revision. */
const HOSTILE = {
  actualReps: 1,
  actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 1000, unit: "LB", basis: "TOTAL" },
  setType: "WARM_UP",
  revision: 99,
} as const satisfies Partial<CompleteSetCommandV1>;

describe("CORE-FIX-01 — performed set ownership on COMPLETE_SET_V1 (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    boss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss.start();
    await ensureProgressionEvaluateSessionQueues(boss);
  });

  afterAll(async () => {
    await cleanup(db, userIds);
    await boss.stop();
  });

  beforeEach(async () => {
    await cleanup(db, userIds);
    userIds.length = 0;
  });

  async function createAthlete(): Promise<string> {
    const id = createEntityId();
    await db.insert(users).values({ id, status: "ACTIVE" });
    userIds.push(id);
    return id;
  }

  async function apply(userId: string, command: WorkoutCommandV1) {
    return processWorkoutCommand(db, boss, userId, command);
  }

  /** An athlete with one started session and one completed set (optionally finished). */
  async function athleteWithSet(options: { finish?: boolean; finishSeq?: number } = {}) {
    const userId = await createAthlete();
    const start = startCommand();
    expect((await apply(userId, start)).outcome).toBe("APPLIED");
    const set = completeCommand(start.workoutSessionId);
    expect((await apply(userId, set)).outcome).toBe("APPLIED");
    if (options.finish === true) {
      const finish = { commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: new Date().toISOString(), workoutSessionId: start.workoutSessionId, completedAt: new Date().toISOString(), finishSeq: options.finishSeq ?? 1 } as const;
      expect((await apply(userId, finish)).outcome).toBe("APPLIED");
    }
    return { userId, sessionId: start.workoutSessionId, set };
  }

  async function setRow(id: string) {
    return db.select().from(performedSets).where(eq(performedSets.id, id));
  }
  async function receiptsOf(userId: string) {
    return db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, userId));
  }
  async function cursorOf(userId: string) {
    return db.select().from(workoutChangeCursor).where(eq(workoutChangeCursor.userId, userId));
  }
  async function exercisesOf(sessionId: string) {
    return db.select().from(performedExercises).where(eq(performedExercises.workoutSessionId, sessionId));
  }
  async function jobsFor(workoutSessionId: string) {
    return boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { data: { workoutSessionId } });
  }

  it("OWN-001 (RED target): athlete B, own session + own new exercise + A's performedSetId -> REJECTED statelessly, A's COMPLETED set byte-identical, no side effects", async () => {
    const a = await athleteWithSet({ finish: true });
    const b = await athleteWithSet();
    const before = await setRow(a.set.performedSetId);
    const aJobsBefore = (await jobsFor(a.sessionId)).length;
    const bReceiptsBefore = await receiptsOf(b.userId);
    const bCursorBefore = await cursorOf(b.userId);
    const bExercisesBefore = await exercisesOf(b.sessionId);

    const attack = completeCommand(b.sessionId, { ...HOSTILE, performedSetId: a.set.performedSetId, sessionSeq: 2 });
    const ack = await apply(b.userId, attack);

    expect(ack).toEqual({ commandId: attack.commandId, outcome: "REJECTED" });
    expect(await setRow(a.set.performedSetId)).toEqual(before);
    // Foreign-ownership convention: no receipt, no cursor row, no half-written exercise for B.
    expect(await receiptsOf(b.userId)).toEqual(bReceiptsBefore);
    expect(await cursorOf(b.userId)).toEqual(bCursorBefore);
    expect(await exercisesOf(b.sessionId)).toEqual(bExercisesBefore);
    // No progression effect for either session.
    expect(await jobsFor(a.sessionId)).toHaveLength(aJobsBefore);
    expect(await jobsFor(b.sessionId)).toHaveLength(0);
    // A replay re-evaluates to the same stateless rejection.
    expect(await apply(b.userId, attack)).toEqual({ commandId: attack.commandId, outcome: "REJECTED" });
    expect(await setRow(a.set.performedSetId)).toEqual(before);
  });

  it("OWN-002: athlete A cannot overwrite athlete B's (ACTIVE-session) set either — symmetric", async () => {
    const a = await athleteWithSet();
    const b = await athleteWithSet();
    const before = await setRow(b.set.performedSetId);

    const attack = completeCommand(a.sessionId, { ...HOSTILE, performedSetId: b.set.performedSetId, sessionSeq: 2 });
    expect((await apply(a.userId, attack)).outcome).toBe("REJECTED");

    expect(await setRow(b.set.performedSetId)).toEqual(before);
    expect((await receiptsOf(a.userId)).map((r) => r.commandId)).not.toContain(attack.commandId);
  });

  it("OWN-003: attacker reusing the victim's performedExerciseId as well is still REJECTED, victim untouched", async () => {
    const a = await athleteWithSet();
    const b = await athleteWithSet();
    const before = await setRow(a.set.performedSetId);

    const attack = completeCommand(b.sessionId, { ...HOSTILE, performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, sessionSeq: 2 });
    expect((await apply(b.userId, attack)).outcome).toBe("REJECTED");
    expect(await setRow(a.set.performedSetId)).toEqual(before);
  });

  it("OWN-004: same athlete, set id of another (COMPLETED) session -> REJECTED with a persisted receipt, historical set untouched, no progression job", async () => {
    const userId = await createAthlete();
    const first = startCommand();
    await apply(userId, first);
    const historical = completeCommand(first.workoutSessionId);
    await apply(userId, historical);
    await apply(userId, { commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: new Date().toISOString(), workoutSessionId: first.workoutSessionId, completedAt: new Date().toISOString(), finishSeq: 1 });
    const second = startCommand();
    await apply(userId, second);
    const before = await setRow(historical.performedSetId);
    const firstJobs = (await jobsFor(first.workoutSessionId)).length;

    const wrongSession = completeCommand(second.workoutSessionId, { ...HOSTILE, performedSetId: historical.performedSetId });
    expect((await apply(userId, wrongSession)).outcome).toBe("REJECTED");

    expect(await setRow(historical.performedSetId)).toEqual(before);
    expect(await exercisesOf(second.workoutSessionId)).toEqual([]);
    expect(await jobsFor(first.workoutSessionId)).toHaveLength(firstJobs);
    expect(await jobsFor(second.workoutSessionId)).toHaveLength(0);
    // Same-owner validation failure: persisted REJECTED receipt (idempotent replay), never a cursor row.
    const receipt = (await receiptsOf(userId)).find((r) => r.commandId === wrongSession.commandId);
    expect(receipt).toEqual(expect.objectContaining({ outcome: "REJECTED", workoutSessionId: second.workoutSessionId }));
    expect((await cursorOf(userId)).map((c) => c.resourceId).filter((id) => id === historical.performedSetId)).toHaveLength(1); // only the original APPLIED
    expect((await apply(userId, wrongSession)).outcome).toBe("REJECTED");
  });

  it("OWN-005: same session, set id under a DIFFERENT performed exercise -> REJECTED, set stays on its exercise unchanged", async () => {
    const a = await athleteWithSet();
    const before = await setRow(a.set.performedSetId);

    const otherExercise = completeCommand(a.sessionId, {
      ...HOSTILE,
      prescriptionExerciseId: "presc-ex-2",
      prescriptionSetId: "presc-set-3",
      exerciseRef: "overhead-press",
      exerciseDisplayName: "Overhead Press",
      exerciseOrder: 1,
      performedSetId: a.set.performedSetId,
      sessionSeq: 2,
    });
    expect((await apply(a.userId, otherExercise)).outcome).toBe("REJECTED");

    expect(await setRow(a.set.performedSetId)).toEqual(before);
    expect((await exercisesOf(a.sessionId)).map((e) => e.id)).toEqual([a.set.performedExerciseId]);
  });

  it("OWN-006: legitimate same-owner correction (same set, same exercise, newer revision) still APPLIES", async () => {
    const a = await athleteWithSet();
    const correction = completeCommand(a.sessionId, { performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, actualReps: 12, revision: 3, sessionSeq: 2 });

    expect((await apply(a.userId, correction)).outcome).toBe("APPLIED");
    expect(await setRow(a.set.performedSetId)).toEqual([expect.objectContaining({ actualReps: 12, revision: 3, performedExerciseId: a.set.performedExerciseId })]);
  });

  it("OWN-007: legitimate duplicate replay -> DUPLICATE; an older-revision recompletion of the own set -> STALE (never reverted)", async () => {
    const a = await athleteWithSet();
    expect((await apply(a.userId, a.set)).outcome).toBe("DUPLICATE");

    const newer = completeCommand(a.sessionId, { performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, actualReps: 11, revision: 4, sessionSeq: 2 });
    expect((await apply(a.userId, newer)).outcome).toBe("APPLIED");
    const older = completeCommand(a.sessionId, { performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, actualReps: 5, revision: 2, sessionSeq: 3 });
    expect((await apply(a.userId, older)).outcome).toBe("STALE");
    expect(await setRow(a.set.performedSetId)).toEqual([expect.objectContaining({ actualReps: 11, revision: 4 })]);
  });

  it("OWN-008: completed-session boundary unchanged — a causally-valid late own correction APPLIES and schedules evaluation; a post-Finish one is REJECTED", async () => {
    // Local Finish happened after a correction (sessionSeq 2) was issued but before it was delivered.
    const a = await athleteWithSet({ finish: true, finishSeq: 2 });
    const jobsBefore = (await jobsFor(a.sessionId)).length;

    const late = completeCommand(a.sessionId, { performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, actualReps: 9, revision: 2, sessionSeq: 2 });
    expect((await apply(a.userId, late)).outcome).toBe("APPLIED");
    expect(await jobsFor(a.sessionId)).toHaveLength(jobsBefore + 1); // a genuine late correction re-schedules evaluation

    const afterFinish = completeCommand(a.sessionId, { performedExerciseId: a.set.performedExerciseId, performedSetId: a.set.performedSetId, actualReps: 3, revision: 3, sessionSeq: 3 });
    expect((await apply(a.userId, afterFinish)).outcome).toBe("REJECTED");

    expect(await setRow(a.set.performedSetId)).toEqual([expect.objectContaining({ actualReps: 9, revision: 2 })]);
    expect(await jobsFor(a.sessionId)).toHaveLength(jobsBefore + 1);
  });

  it("OWN-009: in one batch, the hostile command is REJECTED while the attacker's own valid commands still apply; the victim's data is untouched", async () => {
    const a = await athleteWithSet({ finish: true });
    const bId = await createAthlete();
    const bStart = startCommand();
    const own1 = completeCommand(bStart.workoutSessionId, { sessionSeq: 1 });
    const attack = completeCommand(bStart.workoutSessionId, { ...HOSTILE, performedSetId: a.set.performedSetId, sessionSeq: 2 });
    const own2 = completeCommand(bStart.workoutSessionId, { prescriptionSetId: "presc-set-2", setOrder: 1, performedExerciseId: own1.performedExerciseId, sessionSeq: 3 });
    const before = await setRow(a.set.performedSetId);

    const request = { ownerUserId: bId, commands: [bStart, own1, attack, own2] } as unknown as SyncWorkoutCommandsRequestDto;
    const response = await new WorkoutSyncService(db, boss).syncCommands(bId, request);

    expect(response.acknowledgements.map((ack) => ack.outcome)).toEqual(["APPLIED", "APPLIED", "REJECTED", "APPLIED"]);
    expect(await setRow(a.set.performedSetId)).toEqual(before);
    expect((await db.select().from(performedSets).where(inArray(performedSets.id, [own1.performedSetId, own2.performedSetId]))).map((s) => s.performedExerciseId)).toEqual([own1.performedExerciseId, own1.performedExerciseId]);
  });

  it("OWN-011: concurrent race on a brand-new set id — whoever creates the row owns it; the other side never writes into it", async () => {
    for (let round = 0; round < 20; round += 1) {
      // Fresh athletes each round: both sides target a FREE planned set slot
      // of their own session (CORE-FIX-11 refuses a second set for an
      // occupied planned set slot), so the only contested thing is the id.
      const a = await athleteWithSet();
      const b = await athleteWithSet();
      const contested = createEntityId();
      const fromA = completeCommand(a.sessionId, { performedSetId: contested, prescriptionSetId: "presc-set-2", setOrder: 1, performedExerciseId: a.set.performedExerciseId, actualReps: 7, sessionSeq: 100 + round });
      const fromB = completeCommand(b.sessionId, { ...HOSTILE, performedSetId: contested, prescriptionSetId: "presc-set-2", setOrder: 1, performedExerciseId: b.set.performedExerciseId, sessionSeq: 100 + round });
      const [ackA, ackB] = await Promise.all([apply(a.userId, fromA), apply(b.userId, fromB)]);

      // Exactly one side created the set; the other was refused.
      expect([ackA.outcome, ackB.outcome].sort()).toEqual(["APPLIED", "REJECTED"]);
      const [row] = await setRow(contested);
      const winner = ackA.outcome === "APPLIED" ? fromA : fromB;
      // The row is entirely the winner's: its own exercise and its own values, never a mix.
      expect(row).toEqual(expect.objectContaining({ performedExerciseId: winner.performedExerciseId, actualReps: winner.actualReps, revision: winner.revision, setType: winner.setType }));
    }
  });

  it("OWN-010: after every attack shape, the victim's full footprint (session, exercises, sets, receipts, cursor) is unchanged", async () => {
    const a = await athleteWithSet({ finish: true });
    const b = await athleteWithSet();
    const footprint = async () => ({
      session: await db.select().from(workoutSessions).where(eq(workoutSessions.id, a.sessionId)),
      exercises: await exercisesOf(a.sessionId),
      set: await setRow(a.set.performedSetId),
      receipts: await receiptsOf(a.userId),
      cursor: await cursorOf(a.userId),
    });
    const before = await footprint();

    const shapes: Partial<CompleteSetCommandV1>[] = [
      { performedSetId: a.set.performedSetId },
      { performedSetId: a.set.performedSetId, performedExerciseId: a.set.performedExerciseId },
      { performedSetId: a.set.performedSetId, revision: 1 },
      { performedSetId: a.set.performedSetId, revision: 2_000_000_000 },
    ];
    for (const [index, shape] of shapes.entries()) {
      const attack = completeCommand(b.sessionId, { ...HOSTILE, ...shape, sessionSeq: 10 + index });
      expect((await apply(b.userId, attack)).outcome).toBe("REJECTED");
    }
    expect(await footprint()).toEqual(before);
  });
});

async function cleanup(db: Database, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const sessions = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds));
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    const exercises = await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
    const exerciseIds = exercises.map((e) => e.id);
    if (exerciseIds.length > 0) await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
    await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
  }
  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, userIds));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, userIds));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}
