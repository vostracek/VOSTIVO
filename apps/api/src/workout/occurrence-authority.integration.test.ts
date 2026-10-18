import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import {
  athleteProfiles,
  availableTimeApplications,
  createDatabaseClient,
  performedExercises,
  performedSets,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { createEntityId, selectAvailableTimePrescription, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { availableTimeApplicationFromPreview, type CompleteSetCommandV1, type FinishWorkoutSessionCommandV1, type StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import {
  ProgressionEvaluationService,
  WorkoutHistoryService,
  ensureProgressionEvaluateSessionQueues,
  resolveOccurrenceSessionRoles,
} from "@vostivo/progression-application";
import { AvailableTimePreviewService } from "../plan/available-time-preview.service.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { systemClock } from "../common/clock.js";
import { processWorkoutCommand } from "./workout-command-processing.js";

/**
 * Planned Workout Occurrence Authority V1 — real Postgres, through the real
 * sync command machinery. "Device A"/"Device B" are two independent clients
 * that each started the SAME owned planned workout offline: distinct
 * workoutSessionIds, distinct commandIds, both legitimate.
 *
 * Fixture: Bench Press TIER_1/min 2, 3 x 8-12 @ 60kg; OHP TIER_2/min 0,
 * 2 x 8-12 @ 30kg; 90s rest. 3 x 12 Bench reps -> INCREASE_LOAD.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? "postgres://vostivo:vostivo@localhost:5432/vostivo_dev";
const RACE_ITERATIONS = 25;

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

interface Seeded {
  readonly cycleId: string;
  readonly workoutId: string;
  readonly benchId: string;
  readonly benchSets: readonly string[];
}

describe("Planned Workout Occurrence Authority V1 (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  let planRead: PlanReadService;
  let previewService: AvailableTimePreviewService;
  let progression: ProgressionEvaluationService;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    planRead = new PlanReadService(db, systemClock);
    previewService = new AvailableTimePreviewService(db);
    progression = new ProgressionEvaluationService(db, new WorkoutHistoryService(db));
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
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function addWorkout(cycleId: string, orderIndex: number): Promise<Seeded> {
    const today = new Date().toISOString().slice(0, 10);
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycleId, name: `Upper Body ${orderIndex}`, focus: "Push", orderIndex, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
      .returning();
    const specs = [
      { ref: "bench-press", name: "Bench Press", tier: "TIER_1", min: 2, sets: 3, load: 60000 },
      { ref: "overhead-press", name: "Overhead Press", tier: "TIER_2", min: 0, sets: 2, load: 30000 },
    ] as const;
    let benchId = "";
    let benchSets: string[] = [];
    for (const [index, spec] of specs.entries()) {
      const exerciseId = createEntityId();
      await db.insert(plannedExercises).values({ id: exerciseId, plannedWorkoutId: workout!.id, exerciseRef: spec.ref, displayName: spec.name, orderIndex: index + 1, priorityTier: spec.tier, minimumWorkingSets: spec.min });
      const ids: string[] = [];
      for (let order = 1; order <= spec.sets; order++) {
        const setId = createEntityId();
        ids.push(setId);
        await db.insert(plannedSets).values({ id: setId, plannedExerciseId: exerciseId, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, restSeconds: 90, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: spec.load, loadUnit: "KG", loadBasis: "TOTAL" });
      }
      if (index === 0) {
        benchId = exerciseId;
        benchSets = ids;
      }
    }
    return { cycleId, workoutId: workout!.id, benchId, benchSets };
  }

  async function seed(athlete: Athlete): Promise<Seeded> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId: athlete.athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    return addWorkout(cycle!.id, 1);
  }

  async function prescriptionOf(athlete: Athlete, workoutId: string): Promise<WorkoutPrescriptionV1> {
    return (await planRead.getWorkoutPreview(athlete, workoutId))!.prescription;
  }

  function start(prescription: WorkoutPrescriptionV1, extra: Partial<StartWorkoutSessionCommandV1> = {}): StartWorkoutSessionCommandV1 {
    const nowIso = new Date().toISOString();
    return { commandId: createEntityId(), type: "START_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: nowIso, workoutSessionId: createEntityId(), prescription, startedAt: nowIso, ...extra };
  }

  function completeSet(sessionId: string, performedExerciseId: string, seeded: Seeded, setIndex: number, reps: number, sessionSeq: number): CompleteSetCommandV1 {
    const nowIso = new Date().toISOString();
    return {
      commandId: createEntityId(),
      type: "COMPLETE_SET_V1",
      schemaVersion: 1,
      createdAt: nowIso,
      workoutSessionId: sessionId,
      performedExerciseId,
      prescriptionExerciseId: seeded.benchId,
      exerciseRef: "bench-press",
      exerciseDisplayName: "Bench Press",
      exerciseOrder: 1,
      performedSetId: createEntityId(),
      prescriptionSetId: seeded.benchSets[setIndex]!,
      setOrder: setIndex + 1,
      actualReps: reps,
      actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
      setType: "WORKING",
      revision: 1,
      completedAt: nowIso,
      sessionSeq,
    };
  }

  function finish(sessionId: string, finishSeq: number): FinishWorkoutSessionCommandV1 {
    return { commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: new Date().toISOString(), workoutSessionId: sessionId, completedAt: new Date().toISOString(), finishSeq };
  }

  /** Logs Bench sets (index, reps) and finishes; returns the performed Bench exercise id. */
  async function logBenchAndFinish(athlete: Athlete, sessionId: string, seeded: Seeded, sets: readonly (readonly [number, number])[]): Promise<string> {
    const performedExerciseId = createEntityId();
    let seq = 0;
    for (const [index, reps] of sets) {
      seq += 1;
      expect((await processWorkoutCommand(db, boss, athlete.userId, completeSet(sessionId, performedExerciseId, seeded, index, reps, seq))).outcome).toBe("APPLIED");
    }
    expect((await processWorkoutCommand(db, boss, athlete.userId, finish(sessionId, seq))).outcome).toBe("APPLIED");
    return performedExerciseId;
  }

  async function claimsFor(userId: string) {
    return db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, userId));
  }

  async function rolesOf(userId: string, sessionIds: readonly string[]) {
    const rows = await db.select({ id: workoutSessions.id, prescriptionSnapshot: workoutSessions.prescriptionSnapshot }).from(workoutSessions).where(inArray(workoutSessions.id, [...sessionIds]));
    return resolveOccurrenceSessionRoles(db, userId, rows);
  }

  async function decisionsFor(userId: string) {
    return db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, userId));
  }

  // ------------------------------------------------------------------ START

  it("OCC-001..008: first START claims (CANONICAL); a distinct second START of the same occurrence is ACCEPTED as SECONDARY; both survive intact", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    const deviceB = start(prescription);

    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceA)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceB)).outcome).toBe("APPLIED");

    expect(await claimsFor(athlete.userId)).toMatchObject([{ plannedWorkoutId: seeded.workoutId, canonicalWorkoutSessionId: deviceA.workoutSessionId }]);
    const roles = await rolesOf(athlete.userId, [deviceA.workoutSessionId, deviceB.workoutSessionId]);
    expect(roles.get(deviceA.workoutSessionId)).toBe("CANONICAL");
    expect(roles.get(deviceB.workoutSessionId)).toBe("SECONDARY");

    const sessions = await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId)).orderBy(asc(workoutSessions.createdAt));
    expect(sessions.map((s) => s.id).sort()).toEqual([deviceA.workoutSessionId, deviceB.workoutSessionId].sort());
    for (const session of sessions) expect(session.prescriptionSnapshot).toEqual(prescription);
    const receipts = await db.select().from(workoutCommandReceipts).where(inArray(workoutCommandReceipts.commandId, [deviceA.commandId, deviceB.commandId]));
    expect(receipts.map((r) => r.outcome)).toEqual(["APPLIED", "APPLIED"]);
  });

  it(`OCC-009/010: a CONCURRENT START race (${RACE_ITERATIONS}x, separate connections) — exactly one canonical, both sessions survive, no error/deadlock`, async () => {
    const clientA = createDatabaseClient(DATABASE_URL);
    const clientB = createDatabaseClient(DATABASE_URL);
    const winners = { A: 0, B: 0 };
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const athlete = await createAthlete();
      const seeded = await seed(athlete);
      const prescription = await prescriptionOf(athlete, seeded.workoutId);
      const deviceA = start(prescription);
      const deviceB = start(prescription);

      const [ackA, ackB] = await Promise.all([processWorkoutCommand(clientA, boss, athlete.userId, deviceA), processWorkoutCommand(clientB, boss, athlete.userId, deviceB)]);

      expect([ackA.outcome, ackB.outcome]).toEqual(["APPLIED", "APPLIED"]);
      const claims = await claimsFor(athlete.userId);
      expect(claims).toHaveLength(1);
      expect([deviceA.workoutSessionId, deviceB.workoutSessionId]).toContain(claims[0]!.canonicalWorkoutSessionId);
      expect(await db.select({ id: workoutSessions.id }).from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId))).toHaveLength(2);
      winners[claims[0]!.canonicalWorkoutSessionId === deviceA.workoutSessionId ? "A" : "B"] += 1;
    }
    expect(winners.A + winners.B).toBe(RACE_ITERATIONS);
  });

  it("OCC-011/012: replaying the canonical or the secondary START is idempotent — no new session, no new claim, roles unchanged", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    const deviceB = start(prescription);
    await processWorkoutCommand(db, boss, athlete.userId, deviceA);
    await processWorkoutCommand(db, boss, athlete.userId, deviceB);

    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceA)).outcome).toBe("DUPLICATE");
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceB)).outcome).toBe("DUPLICATE");
    // A second commandId for the SAME secondary session converges (existing protocol) and never steals the claim.
    expect((await processWorkoutCommand(db, boss, athlete.userId, { ...deviceB, commandId: createEntityId() })).outcome).toBe("APPLIED");

    expect(await claimsFor(athlete.userId)).toMatchObject([{ canonicalWorkoutSessionId: deviceA.workoutSessionId }]);
    expect(await db.select({ id: workoutSessions.id }).from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId))).toHaveLength(2);
  });

  it("OCC-013/014: different planned workouts and different athletes get independent claims", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const seededA1 = await seed(athleteA);
    const seededA2 = await addWorkout(seededA1.cycleId, 2);
    const seededB = await seed(athleteB);

    const startA1 = start(await prescriptionOf(athleteA, seededA1.workoutId));
    const startA2 = start(await prescriptionOf(athleteA, seededA2.workoutId));
    const startB = start(await prescriptionOf(athleteB, seededB.workoutId));
    for (const [athlete, command] of [[athleteA, startA1], [athleteA, startA2], [athleteB, startB]] as const) {
      expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    }

    expect((await claimsFor(athleteA.userId)).map((c) => [c.plannedWorkoutId, c.canonicalWorkoutSessionId]).sort()).toEqual(
      [[seededA1.workoutId, startA1.workoutSessionId], [seededA2.workoutId, startA2.workoutSessionId]].sort(),
    );
    expect(await claimsFor(athleteB.userId)).toMatchObject([{ plannedWorkoutId: seededB.workoutId, canonicalWorkoutSessionId: startB.workoutSessionId }]);
  });

  it("OCC-015: a foreign planned workout never becomes a claim candidate (BOLA still REJECTED)", async () => {
    const owner = await createAthlete();
    const attacker = await createAthlete();
    const seeded = await seed(owner);
    const command = start(await prescriptionOf(owner, seeded.workoutId));

    expect(await processWorkoutCommand(db, boss, attacker.userId, command)).toEqual({ commandId: command.commandId, outcome: "REJECTED" });
    expect(await claimsFor(attacker.userId)).toEqual([]);
    expect(await claimsFor(owner.userId)).toEqual([]);
  });

  it("OCC-016: an unplanned START creates no occurrence claim and is never grouped", async () => {
    const athlete = await createAthlete();
    const adHoc: WorkoutPrescriptionV1 = { schemaVersion: 1, prescriptionId: "presc-ad-hoc", name: "Ad hoc", exercises: [] };
    expect((await processWorkoutCommand(db, boss, athlete.userId, start(adHoc))).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, athlete.userId, start(adHoc))).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, athlete.userId, start({ ...adHoc, prescriptionId: createEntityId() }))).outcome).toBe("APPLIED");
    expect(await claimsFor(athlete.userId)).toEqual([]);
  });

  // ------------------------------------------------------------- Plan / Today

  it("OCC-017..021/023: Plan/Today always resolve the CANONICAL session — even when the secondary finished first, has more sets, and sorts/inserts 'earlier'", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceA)).outcome).toBe("APPLIED");

    // One session -> canonical resolved (ACTIVE).
    let preview = await planRead.getWorkoutPreview(athlete, seeded.workoutId);
    expect(preview).toMatchObject({ hasActiveSession: true, canStart: false });

    // Device B: secondary, finishes FIRST with MORE sets; its row is made to look "earlier".
    const deviceB = start(prescription, { workoutSessionId: `00000000${createEntityId().slice(8)}` });
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceB)).outcome).toBe("APPLIED");
    await logBenchAndFinish(athlete, deviceB.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    await db.update(workoutSessions).set({ createdAt: new Date(Date.now() - 86_400_000) }).where(eq(workoutSessions.id, deviceB.workoutSessionId));

    for (let i = 0; i < 3; i++) {
      preview = await planRead.getWorkoutPreview(athlete, seeded.workoutId);
      expect(preview).toMatchObject({ hasActiveSession: true, canStart: false }); // A (ACTIVE), never B (COMPLETED)
      const overview = await planRead.getCurrentPlanOverview(athlete);
      expect(overview.sessions.find((s) => s.plannedWorkoutId === seeded.workoutId)).toMatchObject({ hasActiveSession: true });
    }
    expect(await claimsFor(athlete.userId)).toMatchObject([{ canonicalWorkoutSessionId: deviceA.workoutSessionId }]); // never promoted
  });

  it("OCC-022: the Available-Time preview guard sees the canonical occurrence as already started", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    expect((await processWorkoutCommand(db, boss, athlete.userId, start(await prescriptionOf(athlete, seeded.workoutId)))).outcome).toBe("APPLIED");
    await expect(previewService.preview(athlete, seeded.workoutId, 8)).rejects.toThrow("WORKOUT_ALREADY_STARTED");
  });

  // ---------------------------------------------------------- Data preservation

  it("OCC-DATA: both devices' different sets survive under their own sessions — nothing moved, overwritten or merged; one claim", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    const deviceB = start(prescription);
    await processWorkoutCommand(db, boss, athlete.userId, deviceA);
    await processWorkoutCommand(db, boss, athlete.userId, deviceB);

    await logBenchAndFinish(athlete, deviceA.workoutSessionId, seeded, [[0, 10], [1, 11]]);
    await logBenchAndFinish(athlete, deviceB.workoutSessionId, seeded, [[0, 8], [2, 12]]);

    const setsBySession = async (sessionId: string) =>
      (
        await db
          .select({ prescriptionSetId: performedSets.prescriptionSetId, reps: performedSets.actualReps })
          .from(performedSets)
          .innerJoin(performedExercises, eq(performedExercises.id, performedSets.performedExerciseId))
          .where(eq(performedExercises.workoutSessionId, sessionId))
          .orderBy(asc(performedSets.orderIndex))
      ).map((r) => [r.prescriptionSetId, r.reps]);

    expect(await setsBySession(deviceA.workoutSessionId)).toEqual([[seeded.benchSets[0], 10], [seeded.benchSets[1], 11]]);
    expect(await setsBySession(deviceB.workoutSessionId)).toEqual([[seeded.benchSets[0], 8], [seeded.benchSets[2], 12]]);
    expect(await db.select({ status: workoutSessions.status }).from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId))).toEqual([{ status: "COMPLETED" }, { status: "COMPLETED" }]);
    expect(await claimsFor(athlete.userId)).toMatchObject([{ canonicalWorkoutSessionId: deviceA.workoutSessionId }]);
  });

  // ----------------------------------------------------------------- Progression

  it("OCC-024/025/027: canonical progresses; a SECONDARY finish persists but creates no decision — one planned-occurrence outcome", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    const deviceB = start(prescription);
    await processWorkoutCommand(db, boss, athlete.userId, deviceA);
    await processWorkoutCommand(db, boss, athlete.userId, deviceB);

    const anchorA = await logBenchAndFinish(athlete, deviceA.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    const anchorB = await logBenchAndFinish(athlete, deviceB.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);

    const canonical = await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceA.workoutSessionId, performedExerciseId: anchorA });
    expect(canonical).toMatchObject({ status: "PERSISTED", decision: { data: { decisionType: "INCREASE_LOAD" } } });
    const secondary = await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceB.workoutSessionId, performedExerciseId: anchorB });
    expect(secondary).toEqual({ status: "NOT_CANONICAL_OCCURRENCE_SESSION" });
    // Re-asking is stable (a final skip, not a transient failure).
    expect(await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceB.workoutSessionId, performedExerciseId: anchorB })).toEqual({ status: "NOT_CANONICAL_OCCURRENCE_SESSION" });
    expect(await decisionsFor(athlete.userId)).toHaveLength(1);
  });

  it("OCC-028: sync order reversed (secondary finishes and is evaluated first) — still exactly one outcome, and the secondary never counts as prior evidence", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await prescriptionOf(athlete, seeded.workoutId);
    const deviceA = start(prescription);
    const deviceB = start(prescription);
    await processWorkoutCommand(db, boss, athlete.userId, deviceA);
    await processWorkoutCommand(db, boss, athlete.userId, deviceB);

    const anchorB = await logBenchAndFinish(athlete, deviceB.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    expect(await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceB.workoutSessionId, performedExerciseId: anchorB })).toEqual({ status: "NOT_CANONICAL_OCCURRENCE_SESSION" });

    const anchorA = await logBenchAndFinish(athlete, deviceA.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    const canonical = await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceA.workoutSessionId, performedExerciseId: anchorA });
    if (canonical.status !== "PERSISTED") throw new Error(canonical.status);
    expect(canonical.decision.normalizedInputSnapshot.exposures).toHaveLength(1); // the same occurrence is never counted twice
    expect(await decisionsFor(athlete.userId)).toHaveLength(1);
  });

  it("OCC-029: an ordinary single-session planned workout still progresses normally", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const only = start(await prescriptionOf(athlete, seeded.workoutId));
    await processWorkoutCommand(db, boss, athlete.userId, only);
    const anchor = await logBenchAndFinish(athlete, only.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    expect(await progression.evaluateAndPersist(athlete, { workoutSessionId: only.workoutSessionId, performedExerciseId: anchor })).toMatchObject({ status: "PERSISTED" });
  });

  it("OCC-030/031 + Available-Time: normal and adjusted STARTs compete for the SAME claim; the adjusted SECONDARY keeps its VERIFIED application but never progresses", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const full = await prescriptionOf(athlete, seeded.workoutId);
    const preview = await previewService.preview(athlete, seeded.workoutId, 8); // Bench kept whole, OHP trimmed
    const application = availableTimeApplicationFromPreview(preview);
    if (!application.ok) throw new Error(application.error.reason);
    const adjusted = selectAvailableTimePrescription(full, application.value);
    if (!adjusted.ok) throw new Error(adjusted.error);

    const deviceAdjusted = start(adjusted.value, { availableTimeApplication: application.value });
    const deviceNormal = start(full);
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceNormal)).outcome).toBe("APPLIED"); // reaches the server first
    expect((await processWorkoutCommand(db, boss, athlete.userId, deviceAdjusted)).outcome).toBe("APPLIED");

    const roles = await rolesOf(athlete.userId, [deviceNormal.workoutSessionId, deviceAdjusted.workoutSessionId]);
    expect(roles.get(deviceNormal.workoutSessionId)).toBe("CANONICAL");
    expect(roles.get(deviceAdjusted.workoutSessionId)).toBe("SECONDARY");
    // Being SECONDARY is a separate concept from Available-Time verification.
    expect(await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.workoutSessionId, deviceAdjusted.workoutSessionId))).toMatchObject([{ verificationStatus: "VERIFIED" }]);

    const anchorAdjusted = await logBenchAndFinish(athlete, deviceAdjusted.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    expect(await progression.evaluateAndPersist(athlete, { workoutSessionId: deviceAdjusted.workoutSessionId, performedExerciseId: anchorAdjusted })).toEqual({ status: "NOT_CANONICAL_OCCURRENCE_SESSION" });
    expect(await decisionsFor(athlete.userId)).toEqual([]);
  });

  it("OCC-030: an adjusted CANONICAL session progresses normally", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const full = await prescriptionOf(athlete, seeded.workoutId);
    const application = availableTimeApplicationFromPreview(await previewService.preview(athlete, seeded.workoutId, 8));
    if (!application.ok) throw new Error(application.error.reason);
    const adjusted = selectAvailableTimePrescription(full, application.value);
    if (!adjusted.ok) throw new Error(adjusted.error);
    const command = start(adjusted.value, { availableTimeApplication: application.value });
    await processWorkoutCommand(db, boss, athlete.userId, command);
    const anchor = await logBenchAndFinish(athlete, command.workoutSessionId, seeded, [[0, 12], [1, 12], [2, 12]]);
    expect(await progression.evaluateAndPersist(athlete, { workoutSessionId: command.workoutSessionId, performedExerciseId: anchor })).toMatchObject({ status: "PERSISTED", decision: { data: { decisionType: "INCREASE_LOAD" } } });
  });

  // ------------------------------------------------------------- Atomicity

  it("OCC-ROLLBACK: an unexpected claim-write failure rolls back the whole START (no session, no claim, no receipt); the retry then claims cleanly", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const command = start(await prescriptionOf(athlete, seeded.workoutId));
    const suffix = athlete.userId.replace(/-/g, "_");
    const admin = postgres(MIGRATION_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`CREATE FUNCTION app.test_fail_claim_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = '${athlete.userId}'::uuid THEN RAISE EXCEPTION 'injected occurrence claim failure'; END IF;
          RETURN NEW;
        END $$`);
      await admin.unsafe(`CREATE TRIGGER test_fail_claim_${suffix} BEFORE INSERT ON app.planned_workout_occurrence_claims FOR EACH ROW EXECUTE FUNCTION app.test_fail_claim_${suffix}()`);

      await expect(processWorkoutCommand(db, boss, athlete.userId, command)).rejects.toThrow();
      expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId))).toEqual([]);
      expect(await claimsFor(athlete.userId)).toEqual([]);
      expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, command.commandId))).toEqual([]);
    } finally {
      await admin.unsafe(`DROP TRIGGER IF EXISTS test_fail_claim_${suffix} ON app.planned_workout_occurrence_claims`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS app.test_fail_claim_${suffix}()`);
      await admin.end();
    }

    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    expect(await claimsFor(athlete.userId)).toMatchObject([{ canonicalWorkoutSessionId: command.workoutSessionId }]);
  });

  // ---------------------------------------------------------- Migration backfill

  it("OCC-BACKFILL: migration 0017's own selection — earliest SERVER created_at (id tie-break) per owned occurrence; foreign/ad-hoc sessions never claimed", async () => {
    const owner = await createAthlete();
    const other = await createAthlete();
    const seeded = await seed(owner);
    const prescription = await prescriptionOf(owner, seeded.workoutId);
    const base = Date.now() - 3_600_000;
    // Pre-migration rows: inserted directly, with explicit server timestamps (no claims existed then).
    const later = createEntityId();
    const earliest = createEntityId();
    const tiedLow = `00000000${createEntityId().slice(8)}`;
    await db.insert(workoutSessions).values([
      { id: later, userId: owner.userId, prescriptionSnapshot: prescription, startedAt: new Date(base), status: "COMPLETED", createdAt: new Date(base + 60_000) },
      { id: earliest, userId: owner.userId, prescriptionSnapshot: prescription, startedAt: new Date(base + 120_000), status: "ACTIVE", createdAt: new Date(base) },
      // the other athlete holding a snapshot of the owner's workout (pre-hardening smuggling) — never a candidate
      { id: tiedLow, userId: other.userId, prescriptionSnapshot: prescription, startedAt: new Date(base), status: "ACTIVE", createdAt: new Date(base - 60_000) },
      { id: createEntityId(), userId: owner.userId, prescriptionSnapshot: { schemaVersion: 1, prescriptionId: "presc-ad-hoc", name: "x", exercises: [] }, startedAt: new Date(base), status: "ACTIVE", createdAt: new Date(base - 120_000) },
    ]);

    const migrationsDir = new URL("../../../../packages/database/drizzle/", import.meta.url);
    const file = readdirSync(migrationsDir).find((name) => name.startsWith("0017_"))!;
    const migrationSql = readFileSync(new URL(file, migrationsDir), "utf8");
    const selection = migrationSql.slice(migrationSql.indexOf("SELECT DISTINCT ON"), migrationSql.indexOf(") AS first_session"));
    const admin = postgres(MIGRATION_DATABASE_URL, { max: 1 });
    try {
      const rows = await admin.unsafe(`WITH first_session AS (${selection}) SELECT user_id, planned_workout_id, session_id FROM first_session WHERE user_id IN ('${owner.userId}', '${other.userId}')`);
      expect(rows.map((r) => ({ ...r }))).toEqual([{ user_id: owner.userId, planned_workout_id: seeded.workoutId, session_id: earliest }]);
    } finally {
      await admin.end();
    }
  });
});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, ids));
  await db.delete(availableTimeApplications).where(inArray(availableTimeApplications.userId, ids));
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
