import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  exerciseLoadingCapabilityBindings,
  gymProfiles,
  loadingCapabilities,
  performedExercises,
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplicationCommands,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutSessions,
  plannedWorkoutOccurrenceClaims,
  type Database,
} from "@vostivo/database";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import {
  applyProgression,
  bindExerciseToCapability,
  createLoadingCapability,
  ensureApplicationForDecision,
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";
import { PlanReadService } from "./plan-read.service.js";
import { systemClock } from "../common/clock.js";

/**
 * Real Postgres integration tests (same precedent as
 * workout-sync.integration.test.ts) — run via `pnpm test:integration`,
 * not part of the default `pnpm test` gate.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

interface TestAthlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

async function createTestAthlete(db: Database): Promise<TestAthlete> {
  const userId = createEntityId();
  await db.insert(users).values({ id: userId, status: "ACTIVE" });
  const athleteProfileId = createEntityId();
  await db
    .insert(athleteProfiles)
    .values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC" });
  return { userId, athleteProfileId };
}

interface SeededProgram {
  readonly programId: string;
  readonly versionId: string;
  readonly blockId: string;
  readonly cycleId: string;
  readonly workoutId: string;
  readonly exerciseId: string;
  readonly setId: string;
}

/** One active program, one active version, one block, one current-containing cycle, one workout/exercise/set. */
async function seedMinimalProgram(db: Database, athleteProfileId: string, exerciseRef: string | null = null): Promise<SeededProgram> {
  const [program] = await db
    .insert(programs)
    .values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" })
    .returning();
  const [version] = await db
    .insert(programVersions)
    .values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() })
    .returning();
  const [block] = await db
    .insert(trainingBlocks)
    .values({
      id: createEntityId(),
      programVersionId: version!.id,
      name: "Block 1",
      goal: "Hypertrophy",
      orderIndex: 1,
      cycleCount: 1,
      focusAreas: [{ name: "Back", emphasis: "PRIORITY" }],
    })
    .returning();
  const today = new Date().toISOString().slice(0, 10);
  const [cycle] = await db
    .insert(trainingCycles)
    .values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today })
    .returning();
  const [workout] = await db
    .insert(plannedWorkouts)
    .values({
      id: createEntityId(),
      trainingCycleId: cycle!.id,
      name: "Upper Body A",
      focus: "Push emphasis",
      orderIndex: 1,
      scheduledDate: today,
      estimatedDurationMinutes: 60,
      status: "PLANNED",
    })
    .returning();
  const [exercise] = await db
    .insert(plannedExercises)
    .values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: 1 })
    .returning();
  const [set] = await db
    .insert(plannedSets)
    .values({
      id: createEntityId(),
      plannedExerciseId: exercise!.id,
      orderIndex: 1,
      targetRepsMin: 8,
      targetRepsMax: 12,
      loadKind: "EXTERNAL_WEIGHT",
      loadAmountMilli: 60000,
      loadUnit: "KG",
      loadBasis: "TOTAL",
    })
    .returning();

  return {
    programId: program!.id,
    versionId: version!.id,
    blockId: block!.id,
    cycleId: cycle!.id,
    workoutId: workout!.id,
    exerciseId: exercise!.id,
    setId: set!.id,
  };
}

describe("Plan read API — server-side (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const planRead = new PlanReadService(db, systemClock);
  const testUserIds: string[] = [];

  afterAll(async () => {
    await cleanup(db, testUserIds);
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  it("PLAN-API-001: authenticated athlete gets their current Plan", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    await seedMinimalProgram(db, athlete.athleteProfileId);

    const overview = await planRead.getCurrentPlanOverview({ userId: athlete.userId, athleteProfileId: athlete.athleteProfileId });

    expect(overview.currentBlock?.name).toBe("Block 1");
    expect(overview.sessions).toHaveLength(1);
    expect(overview.sessions[0]?.name).toBe("Upper Body A");
    expect(overview.weeklyFocus).toEqual([{ name: "Back", emphasis: "PRIORITY" }]);
  });

  it("PLAN-API-002: athlete cannot read another athlete's Program (BOLA)", async () => {
    const athleteA = await createTestAthlete(db);
    const athleteB = await createTestAthlete(db);
    testUserIds.push(athleteA.userId, athleteB.userId);
    const seeded = await seedMinimalProgram(db, athleteA.athleteProfileId);

    const preview = await planRead.getWorkoutPreview(
      { userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId },
      seeded.workoutId,
    );

    expect(preview).toBeUndefined();

    // Athlete A can read their own workout — proves the BOLA rejection
    // above is genuinely ownership-based, not a general query bug.
    const ownPreview = await planRead.getWorkoutPreview(
      { userId: athleteA.userId, athleteProfileId: athleteA.athleteProfileId },
      seeded.workoutId,
    );
    expect(ownPreview?.plannedWorkoutId).toBe(seeded.workoutId);
  });

  it("PLAN-API-003: Workout Preview projection is an explicit DTO, not ORM serialization", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    const seeded = await seedMinimalProgram(db, athlete.athleteProfileId);

    const preview = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      seeded.workoutId,
    );

    expect(preview).toBeDefined();
    // No raw DB/internal fields (snake_case columns, trainingCycleId,
    // orderIndex, createdAt/updatedAt) ever leak into the wire shape.
    expect(Object.keys(preview!)).toEqual(
      expect.arrayContaining([
        "plannedWorkoutId",
        "name",
        "focus",
        "estimatedDurationMinutes",
        "displayStatus",
        "hasActiveSession",
        "canStart",
        "exercises",
        "prescription",
      ]),
    );
    expect(preview).not.toHaveProperty("trainingCycleId");
    expect(preview).not.toHaveProperty("orderIndex");
    expect(preview).not.toHaveProperty("createdAt");
  });

  it("PLAN-API-004: completed display state is derived from WorkoutSession reality", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    const seeded = await seedMinimalProgram(db, athlete.athleteProfileId);

    const completedSessionId = createEntityId();
    await db.insert(workoutSessions).values({
      id: completedSessionId,
      userId: athlete.userId,
      prescriptionSnapshot: { schemaVersion: 1, prescriptionId: seeded.workoutId, name: "Upper Body A", exercises: [] },
      startedAt: new Date(),
      status: "COMPLETED",
    });
    // What the real START handler writes with it (Planned Workout Occurrence Authority V1):
    // this session is the occurrence's canonical claim.
    await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId: athlete.userId, plannedWorkoutId: seeded.workoutId, canonicalWorkoutSessionId: completedSessionId });

    const overview = await planRead.getCurrentPlanOverview({ userId: athlete.userId, athleteProfileId: athlete.athleteProfileId });

    expect(overview.sessions[0]?.displayStatus).toBe("COMPLETED");
    expect(overview.sessions[0]?.hasActiveSession).toBe(false);
  });

  it("PLAN-API-005: no active Program returns a safe empty state", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);

    const overview = await planRead.getCurrentPlanOverview({ userId: athlete.userId, athleteProfileId: athlete.athleteProfileId });

    // System clock here: the athlete-local date is today's, whatever day the suite runs.
    expect(overview.athleteLocalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview).toEqual({ currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null }, athleteLocalDate: overview.athleteLocalDate });
  });

  it("rest days are synthesized for cycle dates with no scheduled workout", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const tomorrowIso = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId: athlete.athleteProfileId, name: "P", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: today }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] }).returning();
    // A 2-day cycle: today has a workout, tomorrow does not -> one REST day expected.
    await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: todayIso, endDate: tomorrowIso });
    const [cycle] = await db.select().from(trainingCycles).where(eq(trainingCycles.trainingBlockId, block!.id));
    await db.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper Body A", focus: null, orderIndex: 1, scheduledDate: todayIso, estimatedDurationMinutes: 60, status: "PLANNED" });

    const overview = await planRead.getCurrentPlanOverview({ userId: athlete.userId, athleteProfileId: athlete.athleteProfileId });

    expect(overview.sessions).toHaveLength(2);
    expect(overview.sessions[0]).toMatchObject({ name: "Upper Body A", scheduledDate: todayIso });
    expect(overview.sessions[1]).toMatchObject({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST", scheduledDate: tomorrowIso });
  });

  it("PLAN-005 (integration): a later planned_sets change does not alter an already-stored WorkoutSession prescription snapshot", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    const seeded = await seedMinimalProgram(db, athlete.athleteProfileId);

    const preview = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      seeded.workoutId,
    );
    expect(preview).toBeDefined();
    // REP-004 (real Postgres round trip): the seeded 8-12 range is not
    // collapsed to its minimum anywhere in the read path.
    expect(preview!.prescription.exercises[0]?.sets[0]?.targetReps).toEqual({
      kind: "RANGE",
      minReps: 8,
      maxReps: 12,
    });

    // Simulate WDI's real sync: a WorkoutSession is created with this
    // exact prescription as its immutable snapshot.
    const sessionId = createEntityId();
    await db.insert(workoutSessions).values({
      id: sessionId,
      userId: athlete.userId,
      prescriptionSnapshot: preview!.prescription,
      startedAt: new Date(),
      status: "ACTIVE",
    });

    // Plan data changes after the session already exists.
    await db.update(plannedSets).set({ targetRepsMin: 3, targetRepsMax: 5 }).where(eq(plannedSets.id, seeded.setId));

    const [storedSession] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, sessionId));
    expect(storedSession?.prescriptionSnapshot).toEqual(preview!.prescription);
    // REP-005: re-selecting the durable row after the Plan edit above
    // still shows the original 8-12 range, not the changed 3-5 target.
    const storedSnapshot = storedSession?.prescriptionSnapshot as WorkoutPrescriptionV1;
    expect(storedSnapshot.exercises[0]?.sets[0]?.targetReps).toEqual({ kind: "RANGE", minReps: 8, maxReps: 12 });

    const revisedPreview = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      seeded.workoutId,
    );
    expect(revisedPreview?.prescription).not.toEqual(preview!.prescription);
  });

  // Progression Application V1 Slice C (task §45/§64): the ONE shared
  // resolver wired into Workout Preview — and, transitively, Workout
  // Start, since the mobile client submits `WorkoutPreviewV1.prescription`
  // verbatim as its Start snapshot (`apps/mobile/src/plan/
  // plan-application-service.ts`) — never a second, parallel
  // implementation.
  it("PLAN-APPLIED-PREVIEW (integration): Workout Preview and its embedded Start prescription both reflect an APPLIED progression overlay, never the authored value", async () => {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    const exerciseRef = "bench-press";
    const seeded = await seedMinimalProgram(db, athlete.athleteProfileId, exerciseRef);

    // Before any Apply: Preview shows the authored 60 kg.
    const beforePreview = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      seeded.workoutId,
    );
    expect(beforePreview?.exercises[0]?.sets[0]?.targetLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" });

    // Configure a FIXED_INCREMENT capability and apply one INCREASE_LOAD.
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athlete.athleteProfileId);
    const capability = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capability.status !== "CREATED") throw new Error("expected CREATED capability");
    await bindExerciseToCapability(db, gym.id, exerciseRef, capability.loadingCapabilityId);

    const sourceSessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: sourceSessionId, userId: athlete.userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const sourcePerformedExerciseId = createEntityId();
    await db.insert(performedExercises).values({ id: sourcePerformedExerciseId, workoutSessionId: sourceSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Bench Press", orderIndex: 1 });

    const decisionId = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionId,
      userId: athlete.userId,
      exerciseRef,
      sourceWorkoutSessionId: sourceSessionId,
      sourcePerformedExerciseId,
      sourcePrescriptionExerciseId: seeded.exerciseId,
      engine: "progression",
      policy: "v1",
      decisionType: "INCREASE_LOAD",
      reasonCode: "TOP_OF_RANGE_ACHIEVED",
      evidenceStrength: "SUPPORTED",
      progressionStalled: false,
      recommendedChange: { direction: "INCREASE_LOAD" },
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });

    const ensured = await ensureApplicationForDecision(db, { userId: athlete.userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");
    const applied = await applyProgression(db, { userId: athlete.userId }, { applicationId: ensured.application.id, commandId: createEntityId() });
    if (applied.status !== "APPLIED") throw new Error("expected APPLIED");

    // The SOURCE occurrence's own Preview is never affected by its own
    // application (the strict `effectiveFromCycleOrderIndex <
    // targetCycleOrderIndex` boundary, task §7/§9) — still authored 60 kg.
    const sourcePreviewAfterApply = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      seeded.workoutId,
    );
    expect(sourcePreviewAfterApply?.exercises[0]?.sets[0]?.targetLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" });

    // A LATER occurrence of the same programmed slot (week 2) is what
    // actually shows the applied 62.5 kg.
    const today = new Date().toISOString().slice(0, 10);
    const [week2Cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: seeded.blockId, orderIndex: 2, startDate: today, endDate: today }).returning();
    const [week2Workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: week2Cycle!.id, name: "Upper Body A", orderIndex: 1, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
      .returning();
    const [week2Exercise] = await db
      .insert(plannedExercises)
      .values({ id: createEntityId(), plannedWorkoutId: week2Workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: 1 })
      .returning();
    await db.insert(plannedSets).values({ id: createEntityId(), plannedExerciseId: week2Exercise!.id, orderIndex: 1, targetRepsMin: 8, targetRepsMax: 12, loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: 60000, loadUnit: "KG", loadBasis: "TOTAL" });

    const week2Preview = await planRead.getWorkoutPreview(
      { userId: athlete.userId, athleteProfileId: athlete.athleteProfileId },
      week2Workout!.id,
    );
    const expectedEffective = { kind: "EXTERNAL_WEIGHT", amountMilli: 62500, unit: "KG", basis: "TOTAL" };
    expect(week2Preview?.exercises[0]?.sets[0]?.targetLoad).toEqual(expectedEffective);
    // The embedded Start prescription (what Workout Start actually
    // snapshots) carries the SAME resolved value — one shared resolver,
    // not two divergent implementations (task §64).
    expect(week2Preview?.prescription.exercises[0]?.sets[0]?.targetLoad).toEqual(expectedEffective);

    // The authored planned_sets rows themselves remain untouched (task §3):
    const [rawSet] = await db.select().from(plannedSets).where(eq(plannedSets.id, seeded.setId));
    expect(rawSet?.loadAmountMilli).toBe(60000);
  });
});

async function cleanup(db: Database, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  const athleteProfileRows = await db
    .select({ id: athleteProfiles.id })
    .from(athleteProfiles)
    .where(inArray(athleteProfiles.userId, userIds));
  const athleteProfileIds = athleteProfileRows.map((r) => r.id);

  // Progression Application V1 Slice C (task §64's Plan/Preview
  // integration test needs these) — deleted FIRST: `progression_applications`
  // references `training_blocks`/`program_versions` directly, so it must be
  // gone before either of those is deleted below. Purely additive to this
  // shared cleanup: a no-op for every other test in this file that never
  // creates these rows.
  const commandRows = await db.select({ commandId: progressionApplicationCommands.commandId }).from(progressionApplicationCommands).where(inArray(progressionApplicationCommands.userId, userIds));
  if (commandRows.length > 0) {
    await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.commandId, commandRows.map((r) => r.commandId)));
  }
  await db.delete(progressionApplications).where(inArray(progressionApplications.userId, userIds));
  await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, userIds));
  const performedExerciseRows = await db
    .select({ id: performedExercises.id })
    .from(performedExercises)
    .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
    .where(inArray(workoutSessions.userId, userIds));
  if (performedExerciseRows.length > 0) {
    await db.delete(performedExercises).where(inArray(performedExercises.id, performedExerciseRows.map((r) => r.id)));
  }
  if (athleteProfileIds.length > 0) {
    const gymRows = await db.select({ id: gymProfiles.id }).from(gymProfiles).where(inArray(gymProfiles.athleteProfileId, athleteProfileIds));
    const gymProfileIds = gymRows.map((r) => r.id);
    if (gymProfileIds.length > 0) {
      await db.delete(exerciseLoadingCapabilityBindings).where(inArray(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileIds));
      await db.delete(loadingCapabilities).where(inArray(loadingCapabilities.gymProfileId, gymProfileIds));
      await db.delete(gymProfiles).where(inArray(gymProfiles.id, gymProfileIds));
    }
  }

  const programRows =
    athleteProfileIds.length === 0
      ? []
      : await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, athleteProfileIds));
  const programIds = programRows.map((p) => p.id);

  const versionRows =
    programIds.length === 0
      ? []
      : await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds));
  const versionIds = versionRows.map((v) => v.id);

  const blockRows =
    versionIds.length === 0
      ? []
      : await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
  const blockIds = blockRows.map((b) => b.id);

  const cycleRows =
    blockIds.length === 0
      ? []
      : await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
  const cycleIds = cycleRows.map((c) => c.id);

  const workoutRows =
    cycleIds.length === 0
      ? []
      : await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
  const workoutIds = workoutRows.map((w) => w.id);

  const exerciseRows =
    workoutIds.length === 0
      ? []
      : await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
  const exerciseIds = exerciseRows.map((e) => e.id);

  if (exerciseIds.length > 0) {
    await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
  }
  if (workoutIds.length > 0) {
    await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
  }
  if (cycleIds.length > 0) {
    await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
  }
  if (blockIds.length > 0) {
    await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
  }
  if (versionIds.length > 0) {
    await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
  }
  if (programIds.length > 0) {
    await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
  }
  if (athleteProfileIds.length > 0) {
    await db.delete(programs).where(inArray(programs.athleteProfileId, athleteProfileIds));
  }

  if (userIds.length > 0) {
    await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, userIds));
    await db.delete(workoutSessions).where(inArray(workoutSessions.userId, userIds));
    await db.delete(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}
