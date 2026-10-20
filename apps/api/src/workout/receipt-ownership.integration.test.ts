import { ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  athleteProfiles,
  createDatabaseClient,
  performedExercises,
  performedSets,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  trainingBlocks,
  trainingCycles,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { SYNC_OWNER_MISMATCH, type CompleteSetCommandV1, type FinishWorkoutSessionCommandV1, type ReopenSetCommandV1, type StartWorkoutSessionCommandV1, type WorkoutCommandV1 } from "@vostivo/contracts";
import { ensureProgressionEvaluateSessionQueues } from "@vostivo/progression-application";
import { PlanReadService } from "../plan/plan-read.service.js";
import { systemClock } from "../common/clock.js";
import { processWorkoutCommand } from "./workout-command-processing.js";
import { WorkoutSyncService } from "./workout-sync.service.js";
import type { SyncWorkoutCommandsRequestDto } from "./dto/workout-command.dto.js";

/**
 * Auth & Local Athlete Boundary V1 Slice A — WORKOUT COMMAND IDEMPOTENCY IS
 * OWNER-SCOPED. Real Postgres, through the real command processor.
 *
 * Invariants: AUTH-RECEIPT-001..005, AUTH-LOCAL-006, AUTH-LOCAL-008
 * (docs/domain/AUTH-LOCAL-ATHLETE-BOUNDARY-V1.md §24). "A's local command X
 * submitted under B" is modelled exactly as the server sees it: the same
 * command object, processed with B's authenticated userId.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const CONCURRENCY = 10;

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

interface SeededWorkout {
  readonly workoutId: string;
  readonly benchId: string;
  readonly benchSets: readonly string[];
}

const UNPLANNED_PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "receipt-ownership-unplanned",
  name: "Ad-hoc Push",
  exercises: [
    {
      prescriptionExerciseId: "adhoc-ex-1",
      exerciseRef: "bench-press",
      displayName: "Bench Press",
      order: 0,
      sets: [{ prescriptionSetId: "adhoc-set-1", order: 0, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: null, setType: "WORKING" }],
    },
  ],
};

function startCommand(overrides: Partial<StartWorkoutSessionCommandV1> = {}): StartWorkoutSessionCommandV1 {
  const nowIso = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: nowIso,
    workoutSessionId: createEntityId(),
    prescription: UNPLANNED_PRESCRIPTION,
    startedAt: nowIso,
    ...overrides,
  };
}

function completeCommand(workoutSessionId: string, overrides: Partial<CompleteSetCommandV1> = {}): CompleteSetCommandV1 {
  const nowIso = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: nowIso,
    workoutSessionId,
    performedExerciseId: createEntityId(),
    prescriptionExerciseId: "adhoc-ex-1",
    exerciseRef: "bench-press",
    exerciseDisplayName: "Bench Press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: "adhoc-set-1",
    setOrder: 0,
    actualReps: 10,
    actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
    setType: "WORKING",
    revision: 1,
    completedAt: nowIso,
    sessionSeq: 1,
    ...overrides,
  };
}

function reopenCommand(performedSetId: string, overrides: Partial<ReopenSetCommandV1> = {}): ReopenSetCommandV1 {
  return { commandId: createEntityId(), type: "REOPEN_SET_V1", schemaVersion: 1, createdAt: new Date().toISOString(), performedSetId, revision: 2, sessionSeq: 2, ...overrides };
}

function finishCommand(workoutSessionId: string, overrides: Partial<FinishWorkoutSessionCommandV1> = {}): FinishWorkoutSessionCommandV1 {
  const nowIso = new Date().toISOString();
  return { commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: nowIso, workoutSessionId, completedAt: nowIso, finishSeq: 0, ...overrides };
}

describe("Auth & Local Athlete Boundary V1 Slice A — owner-scoped workout command receipts (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  let planRead: PlanReadService;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    planRead = new PlanReadService(db, systemClock);
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

  async function createAthlete(): Promise<Athlete> {
    const userId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    const athleteProfileId = createEntityId();
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function seedPlannedWorkout(athlete: Athlete): Promise<SeededWorkout> {
    const today = new Date().toISOString().slice(0, 10);
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId: athlete.athleteProfileId, name: "Receipt Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] }).returning();
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper Body A", focus: "Push", orderIndex: 1, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
      .returning();
    const benchId = createEntityId();
    await db.insert(plannedExercises).values({ id: benchId, plannedWorkoutId: workout!.id, exerciseRef: "bench-press", displayName: "Bench Press", orderIndex: 1, priorityTier: "TIER_1", minimumWorkingSets: 2 });
    const benchSets: string[] = [];
    for (let order = 1; order <= 3; order++) {
      const setId = createEntityId();
      benchSets.push(setId);
      await db.insert(plannedSets).values({ id: setId, plannedExerciseId: benchId, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, restSeconds: 90, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: 60000, loadUnit: "KG", loadBasis: "TOTAL" });
    }
    return { workoutId: workout!.id, benchId, benchSets };
  }

  /** A's own START for its planned workout, built exactly like mobile does (the Workout Preview prescription, verbatim). */
  async function plannedStartFor(athlete: Athlete, workoutId: string): Promise<StartWorkoutSessionCommandV1> {
    const preview = await planRead.getWorkoutPreview(athlete, workoutId);
    return startCommand({ prescription: preview!.prescription });
  }

  function receiptsFor(commandId: string) {
    return db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, commandId));
  }

  function receiptOf(userId: string, commandId: string) {
    return db.select().from(workoutCommandReceipts).where(and(eq(workoutCommandReceipts.userId, userId), eq(workoutCommandReceipts.commandId, commandId)));
  }

  function sessionsOf(userId: string) {
    return db.select().from(workoutSessions).where(eq(workoutSessions.userId, userId));
  }

  // -------------------------------------------------------------- 1 / AUTH-RECEIPT-001

  it("RCPT-001: A's valid command -> A's replay returns A's own receipt (DUPLICATE); the receipt is keyed (A, X)", async () => {
    const a = await createAthlete();
    const x = startCommand();

    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("DUPLICATE");

    expect(await receiptsFor(x.commandId)).toEqual([expect.objectContaining({ userId: a.userId, commandId: x.commandId, outcome: "APPLIED" })]);
    expect(await sessionsOf(a.userId)).toHaveLength(1);
  });

  // -------------------------------------------------------------- 2 / AUTH-RECEIPT-003

  it("RCPT-002: B submitting A's already-applied command X never receives A's receipt; A's replay is unchanged", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const x = startCommand();
    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("APPLIED");

    // The literal command (A's session id) under B: evaluated in B's own
    // namespace — never A's DUPLICATE. A's session id is not B's, so it is a
    // foreign-ownership rejection, which leaves no receipt.
    expect((await processWorkoutCommand(db, boss, b.userId, x)).outcome).toBe("REJECTED");
    expect(await receiptOf(b.userId, x.commandId)).toEqual([]);
    expect(await sessionsOf(b.userId)).toEqual([]);

    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("DUPLICATE");
    expect(await receiptsFor(x.commandId)).toEqual([expect.objectContaining({ userId: a.userId, outcome: "APPLIED" })]);
  });

  // -------------------------------------------------------------- 3 / AUTH-RECEIPT-002

  it("RCPT-003: the same commandId used by A and B for two valid commands -> two independent APPLIED results, two ownership-distinct receipts", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const sharedStartId = createEntityId();
    const sharedSetCommandId = createEntityId();
    const aStart = startCommand({ commandId: sharedStartId });
    const bStart = startCommand({ commandId: sharedStartId });

    expect((await processWorkoutCommand(db, boss, a.userId, aStart)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, b.userId, bStart)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, a.userId, completeCommand(aStart.workoutSessionId, { commandId: sharedSetCommandId }))).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, b.userId, completeCommand(bStart.workoutSessionId, { commandId: sharedSetCommandId }))).outcome).toBe("APPLIED");

    for (const commandId of [sharedStartId, sharedSetCommandId]) {
      const rows = await receiptsFor(commandId);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([a.userId, b.userId]));
      expect(rows.every((row) => row.outcome === "APPLIED")).toBe(true);
    }
    const [aSetReceipt] = await receiptOf(a.userId, sharedSetCommandId);
    const [bSetReceipt] = await receiptOf(b.userId, sharedSetCommandId);
    expect(aSetReceipt?.workoutSessionId).toBe(aStart.workoutSessionId);
    expect(bSetReceipt?.workoutSessionId).toBe(bStart.workoutSessionId);

    // Each owner's replay hits only its own receipt.
    expect((await processWorkoutCommand(db, boss, a.userId, aStart)).outcome).toBe("DUPLICATE");
    expect((await processWorkoutCommand(db, boss, b.userId, bStart)).outcome).toBe("DUPLICATE");
    expect(await sessionsOf(a.userId)).toHaveLength(1);
    expect(await sessionsOf(b.userId)).toHaveLength(1);
  });

  // -------------------------------------------------------------- 4 / AUTH-RECEIPT-004 / AUTH-LOCAL-008

  it("RCPT-004: B submits A's planned START X first -> REJECTED with no trace; A's later legitimate X succeeds and claims the occurrence", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const seeded = await seedPlannedWorkout(a);
    const x = await plannedStartFor(a, seeded.workoutId);

    const foreign = await processWorkoutCommand(db, boss, b.userId, x);
    expect(foreign).toEqual({ commandId: x.commandId, outcome: "REJECTED" }); // generic — never says whose plan it is
    expect(await receiptsFor(x.commandId)).toEqual([]);
    expect(await sessionsOf(b.userId)).toEqual([]);
    expect(await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.plannedWorkoutId, seeded.workoutId))).toEqual([]);

    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("APPLIED");
    expect(await receiptsFor(x.commandId)).toEqual([expect.objectContaining({ userId: a.userId, outcome: "APPLIED" })]);
    const claims = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.plannedWorkoutId, seeded.workoutId));
    expect(claims).toEqual([expect.objectContaining({ userId: a.userId, canonicalWorkoutSessionId: x.workoutSessionId })]);
  });

  it("RCPT-004b: A's whole unsynced outbox (START, COMPLETE_SET, FINISH) submitted under B first -> all REJECTED without receipts; A then syncs every command normally", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const seeded = await seedPlannedWorkout(a);
    const start = await plannedStartFor(a, seeded.workoutId);
    const complete = completeCommand(start.workoutSessionId, { prescriptionExerciseId: seeded.benchId, prescriptionSetId: seeded.benchSets[0]!, setOrder: 1, exerciseOrder: 1 });
    const finish = finishCommand(start.workoutSessionId, { finishSeq: 1 });
    const outbox = [start, complete, finish];

    for (const command of outbox) expect((await processWorkoutCommand(db, boss, b.userId, command)).outcome).toBe("REJECTED");
    expect(await db.select().from(workoutCommandReceipts).where(inArray(workoutCommandReceipts.commandId, outbox.map((c) => c.commandId)))).toEqual([]);

    for (const command of outbox) expect((await processWorkoutCommand(db, boss, a.userId, command)).outcome).toBe("APPLIED");
    const [session] = await sessionsOf(a.userId);
    expect(session).toMatchObject({ id: start.workoutSessionId, status: "COMPLETED", finishSeq: 1 });
    expect(await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId))).toHaveLength(1);
  });

  // -------------------------------------------------------------- 5 / unplanned START

  it("RCPT-005: B's otherwise valid UNPLANNED START with commandId X is B's; A's own X is processed independently", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const x = createEntityId();
    const bStart = startCommand({ commandId: x });
    const aStart = startCommand({ commandId: x });

    expect((await processWorkoutCommand(db, boss, b.userId, bStart)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, a.userId, aStart)).outcome).toBe("APPLIED");

    expect((await sessionsOf(b.userId)).map((s) => s.id)).toEqual([bStart.workoutSessionId]);
    expect((await sessionsOf(a.userId)).map((s) => s.id)).toEqual([aStart.workoutSessionId]);
    expect(await receiptOf(a.userId, x)).toEqual([expect.objectContaining({ outcome: "APPLIED" })]);
    expect(await receiptOf(b.userId, x)).toEqual([expect.objectContaining({ outcome: "APPLIED" })]);
  });

  it("RCPT-005b SERVER RESIDUE (closed by Slice B: per-athlete local DB + the batch ownerUserId guard below — a correct client can no longer reach this): the LITERAL unplanned START of A (same workoutSessionId) under B is accepted as B's — the session id, not the receipt, is then taken; A's later X is rejected statelessly and its receipt namespace stays empty", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const x = startCommand();

    expect((await processWorkoutCommand(db, boss, b.userId, x)).outcome).toBe("APPLIED");
    // Nothing on the server can prove the command was authored by A.
    expect((await sessionsOf(b.userId)).map((s) => s.id)).toEqual([x.workoutSessionId]);

    expect((await processWorkoutCommand(db, boss, a.userId, x)).outcome).toBe("REJECTED");
    expect(await receiptOf(a.userId, x.commandId)).toEqual([]); // A's idempotency namespace is not poisoned
    expect(await sessionsOf(a.userId)).toEqual([]);
  });

  // -------------------------------------------------------------- 6 / AUTH-RECEIPT-005

  it("RCPT-006: same owner, same commandId, concurrent identical requests -> exactly one effective mutation, deterministic replay", async () => {
    const a = await createAthlete();
    const start = startCommand();
    const starts = await Promise.all(Array.from({ length: CONCURRENCY }, () => processWorkoutCommand(db, boss, a.userId, start)));
    expect(starts.filter((ack) => ack.outcome === "APPLIED")).toHaveLength(1);
    expect(starts.filter((ack) => ack.outcome === "DUPLICATE")).toHaveLength(CONCURRENCY - 1);
    expect(await sessionsOf(a.userId)).toHaveLength(1);

    const complete = completeCommand(start.workoutSessionId);
    const completes = await Promise.all(Array.from({ length: CONCURRENCY }, () => processWorkoutCommand(db, boss, a.userId, complete)));
    expect(completes.filter((ack) => ack.outcome === "APPLIED")).toHaveLength(1);
    expect(completes.filter((ack) => ack.outcome === "DUPLICATE")).toHaveLength(CONCURRENCY - 1);
    expect(await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId))).toHaveLength(1);
    expect(await db.select().from(workoutChangeCursor).where(eq(workoutChangeCursor.userId, a.userId))).toHaveLength(2);
    expect(await receiptsFor(start.commandId)).toHaveLength(1);
    expect(await receiptsFor(complete.commandId)).toHaveLength(1);
  });

  it("RCPT-006b: two owners racing the same commandId concurrently never block each other", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const x = createEntityId();
    const commands = [
      [a, startCommand({ commandId: x })],
      [b, startCommand({ commandId: x })],
    ] as const;
    const acks = await Promise.all(commands.flatMap(([athlete, command]) => Array.from({ length: CONCURRENCY / 2 }, () => processWorkoutCommand(db, boss, athlete.userId, command))));
    expect(acks.filter((ack) => ack.outcome === "APPLIED")).toHaveLength(2);
    expect(acks.filter((ack) => ack.outcome === "DUPLICATE")).toHaveLength(CONCURRENCY - 2);
    expect(await receiptsFor(x)).toHaveLength(2);
    expect(await sessionsOf(a.userId)).toHaveLength(1);
    expect(await sessionsOf(b.userId)).toHaveLength(1);
  });

  // -------------------------------------------------------------- 7 / 8

  it("RCPT-007: COMPLETE_SET same-owner replay is unchanged — DUPLICATE, one set, no revision change", async () => {
    const a = await createAthlete();
    const start = startCommand();
    await processWorkoutCommand(db, boss, a.userId, start);
    const complete = completeCommand(start.workoutSessionId);

    expect((await processWorkoutCommand(db, boss, a.userId, complete)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, a.userId, complete)).outcome).toBe("DUPLICATE");
    const sets = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(sets).toEqual([expect.objectContaining({ revision: 1, completionState: "COMPLETED" })]);
    expect(await receiptOf(a.userId, complete.commandId)).toEqual([expect.objectContaining({ outcome: "APPLIED", workoutSessionId: start.workoutSessionId, sessionSeq: 1 })]);
  });

  it("RCPT-008: FINISH same-owner replay is unchanged — DUPLICATE, watermark set once", async () => {
    const a = await createAthlete();
    const start = startCommand();
    await processWorkoutCommand(db, boss, a.userId, start);
    const finish = finishCommand(start.workoutSessionId);

    expect((await processWorkoutCommand(db, boss, a.userId, finish)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, a.userId, finish)).outcome).toBe("DUPLICATE");
    expect(await sessionsOf(a.userId)).toEqual([expect.objectContaining({ status: "COMPLETED", finishSeq: 0 })]);
    expect(await receiptsFor(finish.commandId)).toHaveLength(1);
  });

  // -------------------------------------------------------------- 9 / AUTH-RECEIPT-001/003

  it("RCPT-009: a foreign owner's receipt is never the lookup result — B's persisted REJECTED for X does not affect A's X, and A's APPLIED X is not B's DUPLICATE", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const aStart = startCommand();
    const bStart = startCommand();
    await processWorkoutCommand(db, boss, a.userId, aStart);
    await processWorkoutCommand(db, boss, b.userId, bStart);
    const x = createEntityId();

    // B: a same-owner INVALID command (bad load) -> a persisted REJECTED receipt in B's namespace.
    const bInvalid = completeCommand(bStart.workoutSessionId, { commandId: x, actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: -1, unit: "KG", basis: "TOTAL" } });
    expect((await processWorkoutCommand(db, boss, b.userId, bInvalid)).outcome).toBe("REJECTED");
    expect(await receiptOf(b.userId, x)).toEqual([expect.objectContaining({ outcome: "REJECTED" })]);

    // A: its own valid X is evaluated fresh — never B's REJECTED.
    expect((await processWorkoutCommand(db, boss, a.userId, completeCommand(aStart.workoutSessionId, { commandId: x }))).outcome).toBe("APPLIED");
    // B's replay still sees only B's own REJECTED — never A's APPLIED/DUPLICATE.
    expect((await processWorkoutCommand(db, boss, b.userId, bInvalid)).outcome).toBe("REJECTED");
    expect((await receiptsFor(x)).map((row) => [row.userId, row.outcome]).sort()).toEqual([[a.userId, "APPLIED"], [b.userId, "REJECTED"]].sort());
  });

  // -------------------------------------------------------------- 10 / legacy

  it("RCPT-010: a pre-existing (legacy) receipt row is authoritative only for its own user_id, never for an arbitrary current actor", async () => {
    const legacyOwner = await createAthlete();
    const actor = await createAthlete();
    const x = createEntityId();
    // Exactly what a pre-migration row looks like: user_id = the actor that submitted it.
    await db.insert(workoutCommandReceipts).values({ commandId: x, commandType: "START_WORKOUT_SESSION_V1", schemaVersion: 1, userId: legacyOwner.userId, outcome: "REJECTED" });

    const actorStart = startCommand({ commandId: x });
    expect((await processWorkoutCommand(db, boss, actor.userId, actorStart)).outcome).toBe("APPLIED");
    expect(await sessionsOf(actor.userId)).toHaveLength(1);
    expect(await receiptOf(legacyOwner.userId, x)).toEqual([expect.objectContaining({ outcome: "REJECTED" })]); // preserved, untouched
    // …and still authoritative for its own owner.
    expect((await processWorkoutCommand(db, boss, legacyOwner.userId, startCommand({ commandId: x }))).outcome).toBe("REJECTED");
    expect(await sessionsOf(legacyOwner.userId)).toEqual([]);
  });

  // -------------------------------------------------------------- AUTH-LOCAL-006 + persistence categories

  it("RCPT-011 / AUTH-LOCAL-006: BOLA — B cannot complete, reopen or finish A's session; every attempt is REJECTED statelessly and A's data is untouched", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const start = startCommand();
    await processWorkoutCommand(db, boss, a.userId, start);
    const complete = completeCommand(start.workoutSessionId);
    await processWorkoutCommand(db, boss, a.userId, complete);

    const attempts = [completeCommand(start.workoutSessionId, { sessionSeq: 2 }), reopenCommand(complete.performedSetId), finishCommand(start.workoutSessionId, { finishSeq: 2 })];
    for (const attempt of attempts) {
      expect(await processWorkoutCommand(db, boss, b.userId, attempt)).toEqual({ commandId: attempt.commandId, outcome: "REJECTED" });
    }
    expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, b.userId))).toEqual([]);
    expect(await db.select().from(workoutChangeCursor).where(eq(workoutChangeCursor.userId, b.userId))).toEqual([]);
    expect(await sessionsOf(a.userId)).toEqual([expect.objectContaining({ status: "ACTIVE", finishSeq: null })]);
    expect(await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId))).toEqual([expect.objectContaining({ revision: 1, completionState: "COMPLETED" })]);
  });

  it("RCPT-012: same-owner deterministic validation failures still persist their REJECTED receipt (idempotent replay)", async () => {
    const a = await createAthlete();
    const start = startCommand();
    await processWorkoutCommand(db, boss, a.userId, start);

    const badLoad = completeCommand(start.workoutSessionId, { actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: -5, unit: "KG", basis: "TOTAL" } });
    expect((await processWorkoutCommand(db, boss, a.userId, badLoad)).outcome).toBe("REJECTED");
    expect((await processWorkoutCommand(db, boss, a.userId, badLoad)).outcome).toBe("REJECTED");
    expect(await receiptOf(a.userId, badLoad.commandId)).toEqual([expect.objectContaining({ outcome: "REJECTED", workoutSessionId: start.workoutSessionId, sessionSeq: 1 })]);
  });

  // -------------------------------------------------------------- Slice B / batch ownerUserId guard

  /** The real HTTP service path (what the controller calls with the authenticated actor's userId). */
  function syncBatch(actorUserId: string, ownerUserId: string, commands: readonly WorkoutCommandV1[]) {
    const request = { ownerUserId, commands } as unknown as SyncWorkoutCommandsRequestDto;
    return new WorkoutSyncService(db, boss).syncCommands(actorUserId, request);
  }

  async function expectOwnerMismatch(promise: Promise<unknown>): Promise<void> {
    const error: unknown = await promise.then(() => undefined, (rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).message).toBe(SYNC_OWNER_MISMATCH);
  }

  it("SYNC-OWNER-001: actor B + ownerUserId A -> the WHOLE batch is a 409 before any command: zero receipts, sessions, performed sets, claims, cursor rows", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const seeded = await seedPlannedWorkout(a);
    const start = await plannedStartFor(a, seeded.workoutId);
    const complete = completeCommand(start.workoutSessionId, { prescriptionExerciseId: seeded.benchId, prescriptionSetId: seeded.benchSets[0]!, setOrder: 1, exerciseOrder: 1 });
    const finish = finishCommand(start.workoutSessionId, { finishSeq: 1 });
    const batch = [start, complete, finish];

    await expectOwnerMismatch(syncBatch(b.userId, a.userId, batch));

    const commandIds = batch.map((c) => c.commandId);
    expect(await db.select().from(workoutCommandReceipts).where(inArray(workoutCommandReceipts.commandId, commandIds))).toEqual([]);
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.id, start.workoutSessionId))).toEqual([]);
    expect(await sessionsOf(a.userId)).toEqual([]);
    expect(await sessionsOf(b.userId)).toEqual([]);
    expect(await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId))).toEqual([]);
    expect(await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.plannedWorkoutId, seeded.workoutId))).toEqual([]);
    expect(await db.select().from(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, [a.userId, b.userId]))).toEqual([]);
  });

  it("SYNC-OWNER-002: a correct-owner batch behaves exactly as before (per-command acknowledgements, one session, owned by the actor)", async () => {
    const a = await createAthlete();
    const start = startCommand();
    const complete = completeCommand(start.workoutSessionId);

    const response = await syncBatch(a.userId, a.userId, [start, complete]);

    expect(response.acknowledgements).toEqual([
      { commandId: start.commandId, outcome: "APPLIED" },
      { commandId: complete.commandId, outcome: "APPLIED" },
    ]);
    expect((await sessionsOf(a.userId)).map((s) => s.id)).toEqual([start.workoutSessionId]);
    // Replay is still idempotent through the guarded path.
    expect((await syncBatch(a.userId, a.userId, [start, complete])).acknowledgements.map((ack) => ack.outcome)).toEqual(["DUPLICATE", "DUPLICATE"]);
  });

  it("RCPT-005b CLOSED (Slice B defence in depth): A's unsynced UNPLANNED START (X, session S) + set passed to B's network layer -> 409, S not created for anyone, no receipt; A then syncs the same commands -> S belongs to A, nothing lost", async () => {
    const a = await createAthlete();
    const b = await createAthlete();
    const x = startCommand();
    const set = completeCommand(x.workoutSessionId);

    await expectOwnerMismatch(syncBatch(b.userId, a.userId, [x, set]));
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.id, x.workoutSessionId))).toEqual([]);
    expect(await receiptOf(b.userId, x.commandId)).toEqual([]);
    expect(await receiptOf(a.userId, x.commandId)).toEqual([]);

    const response = await syncBatch(a.userId, a.userId, [x, set]);
    expect(response.acknowledgements.map((ack) => ack.outcome)).toEqual(["APPLIED", "APPLIED"]);
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.id, x.workoutSessionId))).toEqual([expect.objectContaining({ userId: a.userId })]);
    expect(await db.select().from(performedSets).where(eq(performedSets.id, set.performedSetId))).toHaveLength(1);
    expect(await receiptOf(a.userId, x.commandId)).toEqual([expect.objectContaining({ outcome: "APPLIED" })]);
    expect(await sessionsOf(b.userId)).toEqual([]);
    expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, b.userId))).toEqual([]);
  });
});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, ids));
  const sessionIds = (await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, ids))).map((r) => r.id);
  if (sessionIds.length > 0) {
    const exerciseIds = (await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds))).map((r) => r.id);
    if (exerciseIds.length > 0) await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
    await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
  }
  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, ids));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, ids));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, ids));

  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, ids))).map((r) => r.id);
  if (profileIds.length > 0) {
    const programIds = (await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, profileIds))).map((r) => r.id);
    const versionIds = programIds.length === 0 ? [] : (await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds))).map((r) => r.id);
    const blockIds = versionIds.length === 0 ? [] : (await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds))).map((r) => r.id);
    const cycleIds = blockIds.length === 0 ? [] : (await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds))).map((r) => r.id);
    const workoutIds = cycleIds.length === 0 ? [] : (await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds))).map((r) => r.id);
    const exerciseIds = workoutIds.length === 0 ? [] : (await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds))).map((r) => r.id);
    if (exerciseIds.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
    if (workoutIds.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
    if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
    if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
    if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
    if (programIds.length > 0) await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
    await db.delete(programs).where(inArray(programs.athleteProfileId, profileIds));
    await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, profileIds));
  }
  await db.delete(users).where(inArray(users.id, ids));
}
