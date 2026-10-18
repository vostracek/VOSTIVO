import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  plannedWorkoutOccurrenceClaims,
  type Database,
} from "@vostivo/database";
import { createEntityId, selectAvailableTimePrescription, type AvailableTimeApplicationV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { availableTimeApplicationFromPreview, type CompleteSetCommandV1, type StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { ensureProgressionEvaluateSessionQueues } from "@vostivo/progression-application";
import { AvailableTimePreviewService } from "../plan/available-time-preview.service.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { systemClock } from "../common/clock.js";
import { processWorkoutCommand } from "./workout-command-processing.js";

/**
 * Available-Time Adaptation V1 — Slice C: adjusted START through the REAL
 * sync command machinery against real Postgres (run via
 * `pnpm test:integration`). Each adjusted START is built exactly the way the
 * mobile client builds it: real server preview -> shared
 * `availableTimeApplicationFromPreview` -> the real effective Workout
 * Preview prescription -> shared `selectAvailableTimePrescription`.
 *
 * Fixture (tech-lead, Slice B §14): Bench TIER_1/min 2 x3, OHP TIER_2/min 0
 * x2, 90s rest. 8 min -> ADJUST 420s (OHP loses its last set).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
// Test-only DDL (the atomicity test's temporary failure trigger) needs the migration/admin role.
const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? "postgres://vostivo:vostivo@localhost:5432/vostivo_dev";

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

interface Seeded {
  readonly programId: string;
  readonly versionId: string;
  readonly workoutId: string;
  readonly benchId: string;
  readonly ohpId: string;
  readonly benchSets: readonly string[];
  readonly ohpSets: readonly string[];
}

const EXERCISES = [
  { exerciseRef: "bench-press", displayName: "Bench Press", priorityTier: "TIER_1", minimumWorkingSets: 2, sets: 3, loadMilli: 60000 },
  { exerciseRef: "overhead-press", displayName: "Overhead Press", priorityTier: "TIER_2", minimumWorkingSets: 0, sets: 2, loadMilli: 30000 },
] as const;

describe("Available-Time adjusted START — server sync (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  let previewService: AvailableTimePreviewService;
  let planRead: PlanReadService;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    previewService = new AvailableTimePreviewService(db);
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
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function seed(athlete: Athlete): Promise<Seeded> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId: athlete.athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper Body A", focus: "Push emphasis", orderIndex: 1, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
      .returning();

    const exerciseIds: string[] = [];
    const setIds: string[][] = [];
    for (const [index, spec] of EXERCISES.entries()) {
      const exerciseId = createEntityId();
      exerciseIds.push(exerciseId);
      await db.insert(plannedExercises).values({
        id: exerciseId,
        plannedWorkoutId: workout!.id,
        exerciseRef: spec.exerciseRef,
        displayName: spec.displayName,
        orderIndex: index + 1,
        priorityTier: spec.priorityTier,
        minimumWorkingSets: spec.minimumWorkingSets,
      });
      const ids: string[] = [];
      for (let order = 1; order <= spec.sets; order++) {
        const setId = createEntityId();
        ids.push(setId);
        await db.insert(plannedSets).values({
          id: setId,
          plannedExerciseId: exerciseId,
          orderIndex: order,
          targetRepsMin: 8,
          targetRepsMax: 12,
          restSeconds: 90,
          setType: "WORKING",
          loadKind: "EXTERNAL_WEIGHT",
          loadAmountMilli: spec.loadMilli,
          loadUnit: "KG",
          loadBasis: "TOTAL",
        });
      }
      setIds.push(ids);
    }
    return { programId: program!.id, versionId: version!.id, workoutId: workout!.id, benchId: exerciseIds[0]!, ohpId: exerciseIds[1]!, benchSets: setIds[0]!, ohpSets: setIds[1]! };
  }

  /** Exactly the mobile client's construction: server preview + server effective prescription -> shared mapping + shared filter. */
  async function buildAdjustedStart(athlete: Athlete, workoutId: string, availableMinutes: number): Promise<{ command: StartWorkoutSessionCommandV1; application: AvailableTimeApplicationV1; full: WorkoutPrescriptionV1 }> {
    const preview = await previewService.preview(athlete, workoutId, availableMinutes);
    const application = availableTimeApplicationFromPreview(preview);
    if (!application.ok) throw new Error(`expected ADJUST_SESSION, got ${JSON.stringify(application.error)}`);
    const full = (await planRead.getWorkoutPreview(athlete, workoutId))!.prescription;
    const adjusted = selectAvailableTimePrescription(full, application.value);
    if (!adjusted.ok) throw new Error(adjusted.error);
    return { command: startCommand(adjusted.value, application.value), application: application.value, full };
  }

  function startCommand(prescription: WorkoutPrescriptionV1, availableTimeApplication?: AvailableTimeApplicationV1): StartWorkoutSessionCommandV1 {
    const nowIso = new Date().toISOString();
    return {
      commandId: createEntityId(),
      type: "START_WORKOUT_SESSION_V1",
      schemaVersion: 1,
      createdAt: nowIso,
      workoutSessionId: createEntityId(),
      prescription,
      startedAt: nowIso,
      ...(availableTimeApplication === undefined ? {} : { availableTimeApplication }),
    };
  }

  async function applicationRows(workoutSessionId: string) {
    return db.select().from(availableTimeApplications).where(eq(availableTimeApplications.workoutSessionId, workoutSessionId));
  }

  async function sessionRows(userId: string) {
    return db.select().from(workoutSessions).where(eq(workoutSessions.userId, userId));
  }

  /** Every plan row an adjusted START could conceivably touch (TODAY_ONLY must be literal). */
  async function planState(seeded: Seeded) {
    const exerciseRows = await db.select().from(plannedExercises).where(eq(plannedExercises.plannedWorkoutId, seeded.workoutId)).orderBy(asc(plannedExercises.orderIndex));
    return {
      versions: await db.select().from(programVersions).where(eq(programVersions.programId, seeded.programId)).orderBy(asc(programVersions.versionNumber)),
      workouts: await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, seeded.workoutId)),
      exercises: exerciseRows,
      sets: await db.select().from(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((e) => e.id))).orderBy(asc(plannedSets.id)),
    };
  }

  /** "Plan moves to ProgramVersion B": the lifecycle transition a future authoring flow performs (A SUPERSEDED, B ACTIVE). */
  async function supersedeWithVersionB(seeded: Seeded): Promise<string> {
    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, seeded.versionId));
    const [versionB] = await db.insert(programVersions).values({ id: createEntityId(), programId: seeded.programId, versionNumber: 2, status: "ACTIVE", activatedAt: new Date() }).returning();
    return versionB!.id;
  }

  function completeSetCommand(workoutSessionId: string, prescriptionExerciseId: string, prescriptionSetId: string): CompleteSetCommandV1 {
    const nowIso = new Date().toISOString();
    return {
      commandId: createEntityId(),
      type: "COMPLETE_SET_V1",
      schemaVersion: 1,
      createdAt: nowIso,
      workoutSessionId,
      performedExerciseId: createEntityId(),
      prescriptionExerciseId,
      exerciseRef: "bench-press",
      exerciseDisplayName: "Bench Press",
      exerciseOrder: 1,
      performedSetId: createEntityId(),
      prescriptionSetId,
      setOrder: 1,
      actualReps: 9,
      actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
      setType: "WORKING",
      revision: 1,
      completedAt: nowIso,
      sessionSeq: 1,
    };
  }

  it("ATS-021/023/025/026/027: owner's fresh adjusted START -> APPLIED, ONE session with the exact adjusted snapshot, ONE VERIFIED application", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command, application } = await buildAdjustedStart(athlete, seeded.workoutId, 8);

    const ack = await processWorkoutCommand(db, boss, athlete.userId, command);
    expect(ack.outcome).toBe("APPLIED");

    const sessions = await sessionRows(athlete.userId);
    expect(sessions).toHaveLength(1);
    const snapshot = sessions[0]!.prescriptionSnapshot as WorkoutPrescriptionV1;
    expect(snapshot).toEqual(command.prescription);
    expect(snapshot.exercises.map((e) => [e.prescriptionExerciseId, e.sets.map((s) => s.prescriptionSetId)])).toEqual([
      [seeded.benchId, seeded.benchSets],
      [seeded.ohpId, [seeded.ohpSets[0]]],
    ]);

    const rows = await applicationRows(command.workoutSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: athlete.userId,
      plannedWorkoutId: seeded.workoutId,
      sourceProgramVersionId: seeded.versionId,
      scope: "TODAY_ONLY",
      policyVersion: "available-time/v1",
      availableMinutes: 8,
      previewFingerprint: application.previewFingerprint,
      originalEstimatedSeconds: 540,
      adjustedEstimatedSeconds: 420,
      verificationStatus: "VERIFIED",
      verificationReason: null,
    });
    expect(rows[0]!.structuralDiff).toEqual([
      { plannedExerciseId: seeded.benchId, retainedPlannedSetIds: seeded.benchSets, removedPlannedSetIds: [] },
      { plannedExerciseId: seeded.ohpId, retainedPlannedSetIds: [seeded.ohpSets[0]], removedPlannedSetIds: [seeded.ohpSets[1]] },
    ]);
  });

  it("ATS-011: progressed/effective load on a retained set is preserved — Available-Time never recalculates load", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command, full } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    const fullBench = full.exercises.find((e) => e.prescriptionExerciseId === seeded.benchId)!;
    const adjustedBench = command.prescription.exercises.find((e) => e.prescriptionExerciseId === seeded.benchId)!;
    expect(adjustedBench.sets).toEqual(fullBench.sets);
    expect(adjustedBench.sets[0]).toMatchObject({ targetLoad: { amountMilli: 60000 }, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 90, setType: "WORKING" });
  });

  it("ATS-028/029: replaying the same command is idempotent — one session, one application, DUPLICATE ack", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command } = await buildAdjustedStart(athlete, seeded.workoutId, 8);

    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("DUPLICATE");
    // A different commandId for the same session (e.g. a re-enqueued START) still converges.
    expect((await processWorkoutCommand(db, boss, athlete.userId, { ...command, commandId: createEntityId() })).outcome).toBe("APPLIED");

    expect(await sessionRows(athlete.userId)).toHaveLength(1);
    expect(await applicationRows(command.workoutSessionId)).toHaveLength(1);
    expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, command.commandId))).toHaveLength(1);
  });

  it("ATS-022: BOLA — another athlete replaying a foreign application/source is REJECTED, nothing persisted", async () => {
    const owner = await createAthlete();
    const attacker = await createAthlete();
    const seeded = await seed(owner);
    const { command } = await buildAdjustedStart(owner, seeded.workoutId, 8);

    const ack = await processWorkoutCommand(db, boss, attacker.userId, command);
    expect(ack.outcome).toBe("REJECTED");
    expect(await sessionRows(attacker.userId)).toEqual([]);
    expect(await applicationRows(command.workoutSessionId)).toEqual([]);
  });

  it("ATS-034: foreign/forged identities stay hard-rejected (set, exercise, source version, snapshot)", async () => {
    const athlete = await createAthlete();
    const other = await createAthlete();
    const seeded = await seed(athlete);
    const foreign = await seed(other);
    const { command, application, full } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    const [bench, ohp] = application.exercises;

    const forgeries: StartWorkoutSessionCommandV1[] = [
      // a removed set id that belongs to someone else's workout
      { ...command, commandId: createEntityId(), workoutSessionId: createEntityId(), availableTimeApplication: { ...application, exercises: [bench!, { ...ohp!, removedPlannedSetIds: [foreign.ohpSets[1]!] }] } },
      // an exercise id that is not this workout's
      { ...command, commandId: createEntityId(), workoutSessionId: createEntityId(), availableTimeApplication: { ...application, exercises: [bench!, { ...ohp!, plannedExerciseId: foreign.ohpId }] } },
      // a source ProgramVersion that is not this workout's (even an owned-looking one)
      { ...command, commandId: createEntityId(), workoutSessionId: createEntityId(), availableTimeApplication: { ...application, sourceProgramVersionId: foreign.versionId } },
      // the snapshot is NOT the claimed retained structure (full, unadjusted prescription)
      { ...command, commandId: createEntityId(), workoutSessionId: createEntityId(), prescription: full },
    ];
    for (const forged of forgeries) {
      expect((await processWorkoutCommand(db, boss, athlete.userId, forged)).outcome).toBe("REJECTED");
    }
    expect(await sessionRows(athlete.userId)).toEqual([]);
    expect(await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.userId, athlete.userId))).toEqual([]);
  });

  async function expectRejectedWithoutTrace(athlete: Athlete, command: StartWorkoutSessionCommandV1): Promise<void> {
    const ack = await processWorkoutCommand(db, boss, athlete.userId, command);
    expect(ack).toEqual({ commandId: command.commandId, outcome: "REJECTED" });
    expect(await sessionRows(athlete.userId)).toEqual([]);
    expect(await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.userId, athlete.userId))).toEqual([]);
    const [receipt] = await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, command.commandId));
    expect(receipt).toMatchObject({ outcome: "REJECTED", workoutSessionId: null }); // the existing protocol's REJECTED receipt
  }

  it("ATS-024/C04: evaluable source + an exact-diff mismatch is a PROVEN contradiction -> REJECTED, no session/application (never UNVERIFIED)", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { application, full } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    // Genuine fingerprint/durations, but the client claims Bench (TIER_1) lost its last
    // set instead of OHP (TIER_2) — a well-formed, owned partition the engine never produces.
    const tampered: AvailableTimeApplicationV1 = {
      ...application,
      exercises: [
        { plannedExerciseId: seeded.benchId, retainedPlannedSetIds: seeded.benchSets.slice(0, 2), removedPlannedSetIds: [seeded.benchSets[2]!] },
        { plannedExerciseId: seeded.ohpId, retainedPlannedSetIds: seeded.ohpSets, removedPlannedSetIds: [] },
      ],
    };
    const adjusted = selectAvailableTimePrescription(full, tampered);
    if (!adjusted.ok) throw new Error(adjusted.error);
    await expectRejectedWithoutTrace(athlete, startCommand(adjusted.value, tampered));
  });

  it("ATS-C03: evaluable source + a fingerprint mismatch -> REJECTED, no session/application", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command, application } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    await expectRejectedWithoutTrace(athlete, { ...command, availableTimeApplication: { ...application, previewFingerprint: "c".repeat(64) } });
  });

  it("ATS-C05: evaluable source + a duration mismatch -> REJECTED", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command, application } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    await expectRejectedWithoutTrace(athlete, { ...command, availableTimeApplication: { ...application, adjustedEstimatedSeconds: 400 } });
  });

  it("ATS-C06: evaluable source + a result-kind mismatch (the genuine 9-min preview is NO_CHANGE) -> REJECTED", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command, application } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    const noChange = await previewService.preview(athlete, seeded.workoutId, 9);
    expect(noChange.result).toBe("NO_CHANGE");
    // A self-consistent ADJUST claim riding on the genuine 9-minute fingerprint.
    await expectRejectedWithoutTrace(athlete, { ...command, availableTimeApplication: { ...application, availableMinutes: 9, previewFingerprint: noChange.previewFingerprint } });
  });

  it("ATS-030/031/032/035: preview from version A, plan moves to B before sync -> session ACCEPTED, application STALE, snapshot untouched, later sets still apply", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command } = await buildAdjustedStart(athlete, seeded.workoutId, 8); // local start happens here
    const versionB = await supersedeWithVersionB(seeded); // ...then the plan moves on before sync
    const planBefore = await planState(seeded);

    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");

    const [session] = await sessionRows(athlete.userId);
    expect(session!.prescriptionSnapshot).toEqual(command.prescription); // the A-based snapshot, exactly
    expect(await applicationRows(command.workoutSessionId)).toMatchObject([{ sourceProgramVersionId: seeded.versionId, verificationStatus: "STALE", verificationReason: "SOURCE_NOT_CURRENT" }]);
    expect(await planState(seeded)).toEqual(planBefore); // neither A nor B touched
    expect(planBefore.versions.map((v) => [v.id, v.status])).toEqual([[seeded.versionId, "SUPERSEDED"], [versionB, "ACTIVE"]]);

    const complete = completeSetCommand(command.workoutSessionId, seeded.benchId, seeded.benchSets[0]!);
    expect((await processWorkoutCommand(db, boss, athlete.userId, complete)).outcome).toBe("APPLIED");
    const [performed] = await db.select().from(performedSets).where(eq(performedSets.id, complete.performedSetId));
    expect(performed).toMatchObject({ actualReps: 9, prescriptionSetId: seeded.benchSets[0] });
    expect((await sessionRows(athlete.userId))[0]!.prescriptionSnapshot).toEqual(command.prescription);
  });

  it("ATS-035/036/037/038/039: adjusted START mutates no plan row and creates no decision/progression/memory artifact", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command } = await buildAdjustedStart(athlete, seeded.workoutId, 6);
    const planBefore = await planState(seeded);

    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");

    expect(await planState(seeded)).toEqual(planBefore);
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, athlete.userId))).toEqual([]);
    expect(await db.select().from(progressionApplications).where(eq(progressionApplications.userId, athlete.userId))).toEqual([]);
    // There is no EngineDecision or Athlete Memory persistence in the schema at all — the
    // session-scoped application row is the only Available-Time artifact.
    const memoryLikeTables = await db.execute<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' AND (table_name ILIKE '%memory%' OR table_name ILIKE '%engine_decision%')`,
    );
    expect([...memoryLikeTables]).toEqual([]);
  });

  it("ATS-040: an ordinary START (no application) is unchanged — APPLIED, no Available-Time row", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const full = (await planRead.getWorkoutPreview(athlete, seeded.workoutId))!.prescription;
    const command = startCommand(full);
    expect("availableTimeApplication" in command).toBe(false);

    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    expect((await sessionRows(athlete.userId))[0]!.prescriptionSnapshot).toEqual(full);
    expect(await applicationRows(command.workoutSessionId)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Server START atomicity (closure §3/§6) — a TEST-ONLY database failure:
  // a temporary trigger, scoped to this one test user, that makes the
  // Available-Time application insert fail AFTER the session insert ran.
  // Installed through the migration/admin role (the runtime role cannot
  // create triggers) and always dropped in `finally`.
  // ---------------------------------------------------------------------
  it("ATS-C19/C20/C21: a forced application-insert failure rolls back the WHOLE START; the retry then applies cleanly", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const { command } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    const suffix = athlete.userId.replace(/-/g, "_");
    const admin = postgres(MIGRATION_DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`CREATE FUNCTION app.test_fail_ata_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = '${athlete.userId}'::uuid THEN RAISE EXCEPTION 'injected available-time application failure'; END IF;
          RETURN NEW;
        END $$`);
      await admin.unsafe(`CREATE TRIGGER test_fail_ata_${suffix} BEFORE INSERT ON app.available_time_applications
        FOR EACH ROW EXECUTE FUNCTION app.test_fail_ata_${suffix}()`);

      // Existing protocol: an unexpected server failure is not an outcome — it
      // surfaces as an error (a 5xx on the wire), which the client retries.
      await expect(processWorkoutCommand(db, boss, athlete.userId, command)).rejects.toThrow();

      expect(await sessionRows(athlete.userId)).toEqual([]); // no session without its application
      expect(await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.userId, athlete.userId))).toEqual([]);
      expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, command.commandId))).toEqual([]);
      expect(await db.select().from(workoutChangeCursor).where(eq(workoutChangeCursor.userId, athlete.userId))).toEqual([]);
    } finally {
      await admin.unsafe(`DROP TRIGGER IF EXISTS test_fail_ata_${suffix} ON app.available_time_applications`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS app.test_fail_ata_${suffix}()`);
      await admin.end();
    }

    // The same command, retried after the failure is gone, applies exactly once.
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    expect(await sessionRows(athlete.userId)).toHaveLength(1);
    expect(await applicationRows(command.workoutSessionId)).toMatchObject([{ verificationStatus: "VERIFIED" }]);
    expect(await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, command.commandId))).toMatchObject([{ outcome: "APPLIED" }]);
  });

  // ---------------------------------------------------------------------
  // Ordinary START provenance hardening (closure §2/§5).
  // ---------------------------------------------------------------------
  async function ownFullPrescription(athlete: Athlete, seeded: Seeded): Promise<WorkoutPrescriptionV1> {
    return (await planRead.getWorkoutPreview(athlete, seeded.workoutId))!.prescription;
  }

  it("START-PROV-011/018: ordinary START of the athlete's own planned workout applies, and replays idempotently", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const command = startCommand(await ownFullPrescription(athlete, seeded));
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("DUPLICATE");
    expect(await sessionRows(athlete.userId)).toHaveLength(1);
  });

  it("START-PROV-012/015: another athlete's planned workout cannot be attached — REJECTED, nothing persisted, nothing leaked", async () => {
    const owner = await createAthlete();
    const attacker = await createAthlete();
    const seeded = await seed(owner);
    const command = startCommand(await ownFullPrescription(owner, seeded));

    const ack = await processWorkoutCommand(db, boss, attacker.userId, command);
    // The acknowledgement carries no reason and no canonical data — exactly the same shape
    // as any other rejection.
    expect(ack).toEqual({ commandId: command.commandId, outcome: "REJECTED" });
    expect(await sessionRows(attacker.userId)).toEqual([]);
  });

  it("START-PROV-013: foreign ProgramVersion provenance is rejected (the ordinary snapshot carries none; the adjusted one is checked)", async () => {
    // WorkoutPrescriptionV1 has no ProgramVersion field: an ordinary START's version is
    // implied by its owned planned workout (START-PROV-012). The adjusted START's explicit
    // sourceProgramVersionId is checked in ATS-034; asserted again here for the closure list.
    const athlete = await createAthlete();
    const other = await createAthlete();
    const seeded = await seed(athlete);
    const foreign = await seed(other);
    const { command, application } = await buildAdjustedStart(athlete, seeded.workoutId, 8);
    await expectRejectedWithoutTrace(athlete, { ...command, availableTimeApplication: { ...application, sourceProgramVersionId: foreign.versionId } });
  });

  it("START-PROV-014: foreign planned exercise/set provenance cannot be smuggled into a snapshot", async () => {
    const athlete = await createAthlete();
    const other = await createAthlete();
    const seeded = await seed(athlete);
    const foreign = await seed(other);
    const own = await ownFullPrescription(athlete, seeded);
    const foreignFull = await ownFullPrescription(other, foreign);
    const [bench, ohp] = own.exercises;

    const smuggled: WorkoutPrescriptionV1[] = [
      // own planned workout, but one exercise is another athlete's
      { ...own, exercises: [bench!, foreignFull.exercises[1]!] },
      // own planned workout, own exercise, but a foreign set inside it
      { ...own, exercises: [{ ...bench!, sets: [...bench!.sets, foreignFull.exercises[0]!.sets[0]!] }, ohp!] },
      // own sets moved under a different own exercise (inconsistent provenance)
      { ...own, exercises: [{ ...bench!, sets: [...bench!.sets, ohp!.sets[0]!] }] },
      // an "unplanned" prescription id carrying another athlete's planned exercise/sets
      { ...foreignFull, prescriptionId: `ad-hoc-${createEntityId()}` },
      // a fresh UUID prescription id carrying another athlete's planned set
      { schemaVersion: 1, prescriptionId: createEntityId(), name: "Ad hoc", exercises: [{ ...bench!, prescriptionExerciseId: createEntityId(), sets: [foreignFull.exercises[0]!.sets[0]!] }] },
    ];
    for (const prescription of smuggled) {
      const command = startCommand(prescription);
      expect(await processWorkoutCommand(db, boss, athlete.userId, command)).toEqual({ commandId: command.commandId, outcome: "REJECTED" });
    }
    expect(await sessionRows(athlete.userId)).toEqual([]);
  });

  it("START-PROV-016: a legitimate unplanned START (no planned provenance) is still accepted", async () => {
    const athlete = await createAthlete();
    const unplanned: WorkoutPrescriptionV1[] = [
      { schemaVersion: 1, prescriptionId: "presc-ad-hoc-1", name: "Ad hoc", exercises: [{ prescriptionExerciseId: "presc-ex-1", exerciseRef: null, displayName: "Push-up", order: 0, sets: [{ prescriptionSetId: "presc-set-1", order: 0, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: null, setType: "WORKING" }] }] },
      { schemaVersion: 1, prescriptionId: createEntityId(), name: "Ad hoc (client UUIDs)", exercises: [{ prescriptionExerciseId: createEntityId(), exerciseRef: null, displayName: "Dips", order: 0, sets: [{ prescriptionSetId: createEntityId(), order: 0, targetReps: null, targetLoad: null, restSeconds: null, setType: "WORKING" }] }] },
    ];
    for (const prescription of unplanned) {
      expect((await processWorkoutCommand(db, boss, athlete.userId, startCommand(prescription))).outcome).toBe("APPLIED");
    }
    expect(await sessionRows(athlete.userId)).toHaveLength(2);
  });

  it("START-PROV-017: owned provenance from a no-longer-current ProgramVersion is NOT rejected (ownership, not freshness)", async () => {
    const athlete = await createAthlete();
    const seeded = await seed(athlete);
    const prescription = await ownFullPrescription(athlete, seeded); // fetched while A is current
    await supersedeWithVersionB(seeded);
    expect((await processWorkoutCommand(db, boss, athlete.userId, startCommand(prescription))).outcome).toBe("APPLIED");
  });

});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  await db.delete(availableTimeApplications).where(inArray(availableTimeApplications.userId, ids));
  const sessionIds = (await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, ids))).map((r) => r.id);
  if (sessionIds.length > 0) {
    const exerciseIds = (await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds))).map((r) => r.id);
    if (exerciseIds.length > 0) await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
    await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
  }
  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, ids));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, ids));
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, ids));
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
