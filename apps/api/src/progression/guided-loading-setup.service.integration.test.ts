import { ConflictException, NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type Database,
} from "@vostivo/database";
import { createEntityId, type ExperienceMode } from "@vostivo/domain";
import { applySystemProgression, ensureApplicationForDecision } from "@vostivo/progression-application";
import { GuidedLoadingSetupService } from "./guided-loading-setup.service.js";

/**
 * Progression Application V1 — Slice F — real Postgres integration tests
 * for the API's own `GuidedLoadingSetupService` (task's own test matrix
 * items 15/16/18, plus a basic end-to-end pass-through proof). The full
 * domain-level test matrix (recoverable-reason derivation, shared-
 * capability safety, identical-config reuse, binding-race safety, etc.)
 * is proven directly against `@vostivo/progression-application`'s own
 * `guided-loading-setup.integration.test.ts` — this file only proves the
 * HTTP-boundary mapping (404/409) and pass-through correctness, the same
 * convention `progression-review.service.integration.test.ts` already
 * established for Slice E.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("GuidedLoadingSetupService (real Postgres)", () => {
  let db: Database;
  let service: GuidedLoadingSetupService;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
    service = new GuidedLoadingSetupService(db);
  });

  async function createAthlete(experienceMode: ExperienceMode): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode, unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function seedProgram(athleteProfileId: string, exerciseRef: string, loadAmountMilli = 100000): Promise<{ readonly exerciseId: string; readonly exerciseRef: string }> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: 1, status: "PLANNED" }).returning();
    const [exercise] = await db.insert(plannedExercises).values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Incline Dumbbell Press", orderIndex: 1 }).returning();
    await db.insert(plannedSets).values({ id: createEntityId(), plannedExerciseId: exercise!.id, orderIndex: 1, targetRepsMin: 8, targetRepsMax: 12, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli, loadUnit: "KG", loadBasis: "TOTAL" });
    return { exerciseId: exercise!.id, exerciseRef };
  }

  async function createBlockedApplication(userId: string, exerciseRef: string, exerciseId: string): Promise<string> {
    const workoutSessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db.insert(performedExercises).values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Incline Dumbbell Press", orderIndex: 1 });
    const decisionId = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionId,
      userId,
      exerciseRef,
      sourceWorkoutSessionId: workoutSessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId: exerciseId,
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
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");
    await applySystemProgression(db, { applicationId: ensured.application.id, systemCommandId: createEntityId() });
    return ensured.application.id;
  }

  afterEach(async () => {
    if (userIds.length === 0) return;

    const applicationRows = await db.select({ id: progressionApplications.id }).from(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    const applicationIds = applicationRows.map((r) => r.id);
    if (applicationIds.length > 0) await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.applicationId, applicationIds));
    await db.delete(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, userIds));

    const sessionRows = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds));
    const sessionIds = sessionRows.map((r) => r.id);
    if (sessionIds.length > 0) {
      const exerciseRows = await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exerciseRows.map((r) => r.id);
      if (exerciseIds.length > 0) await db.delete(performedExercises).where(inArray(performedExercises.id, exerciseIds));
      await db.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
    }

    const athleteRows = await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
    const athleteProfileIds = athleteRows.map((r) => r.id);
    if (athleteProfileIds.length > 0) {
      const gymRows = await db.select({ id: gymProfiles.id }).from(gymProfiles).where(inArray(gymProfiles.athleteProfileId, athleteProfileIds));
      const gymProfileIds = gymRows.map((r) => r.id);
      if (gymProfileIds.length > 0) {
        await db.delete(exerciseLoadingCapabilityBindings).where(inArray(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileIds));
        await db.delete(loadingCapabilities).where(inArray(loadingCapabilities.gymProfileId, gymProfileIds));
        await db.delete(gymProfiles).where(inArray(gymProfiles.id, gymProfileIds));
      }
      const programRows = await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, athleteProfileIds));
      const programIds = programRows.map((r) => r.id);
      if (programIds.length > 0) {
        const versionRows = await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds));
        const versionIds = versionRows.map((r) => r.id);
        const blockRows = await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        const blockIds = blockRows.map((r) => r.id);
        const cycleRows = await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        const cycleIds = cycleRows.map((r) => r.id);
        const workoutRows = await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        const workoutIds = workoutRows.map((r) => r.id);
        const exerciseRows = await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        const exerciseIds = exerciseRows.map((r) => r.id);
        if (exerciseIds.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
        if (workoutIds.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        if (programIds.length > 0) await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
        await db.delete(programs).where(inArray(programs.id, programIds));
      }
      await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, athleteProfileIds));
    }

    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  it("PROG-API-F-001: GET attention returns the item for GUIDED, empty for ADAPTIVE", async () => {
    const guided = await createAthlete("GUIDED");
    const plan = await seedProgram(guided.athleteProfileId, "prog-api-f-001");
    const applicationId = await createBlockedApplication(guided.userId, plan.exerciseRef, plan.exerciseId);

    const attention = await service.getAttention({ userId: guided.userId, athleteProfileId: guided.athleteProfileId });
    expect(attention.item?.applicationId).toBe(applicationId);
    expect(attention.item?.exerciseDisplayName).toBe("Incline Dumbbell Press");
    expect(attention.item?.recoverableReason).toBe("LOADING_CAPABILITY_UNAVAILABLE");

    const adaptive = await createAthlete("ADAPTIVE");
    const planAdaptive = await seedProgram(adaptive.athleteProfileId, "prog-api-f-001-adaptive");
    await createBlockedApplication(adaptive.userId, planAdaptive.exerciseRef, planAdaptive.exerciseId);
    const adaptiveAttention = await service.getAttention({ userId: adaptive.userId, athleteProfileId: adaptive.athleteProfileId });
    expect(adaptiveAttention.item).toBeNull();
  });

  it("PROG-API-F-002: GET context is BOLA-safe (404 for a non-owning actor)", async () => {
    const athleteA = await createAthlete("GUIDED");
    const athleteB = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteA.athleteProfileId, "prog-api-f-002");
    const applicationId = await createBlockedApplication(athleteA.userId, plan.exerciseRef, plan.exerciseId);

    const context = await service.getContext({ userId: athleteA.userId, athleteProfileId: athleteA.athleteProfileId }, applicationId);
    expect(context.status).toBe("AVAILABLE");

    await expect(service.getContext({ userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId }, applicationId)).rejects.toThrow(NotFoundException);
  });

  it("PROG-API-F-003: Save succeeds end-to-end (APPLIED) and is rejected as MODE_ACTION_NOT_ALLOWED once mode changes", async () => {
    const guided = await createAthlete("GUIDED");
    const plan = await seedProgram(guided.athleteProfileId, "prog-api-f-003", 100000);
    const applicationId = await createBlockedApplication(guided.userId, plan.exerciseRef, plan.exerciseId);

    const saveResult = await service.save({ userId: guided.userId, athleteProfileId: guided.athleteProfileId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(saveResult).toEqual({ status: "APPLIED" });

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    // A second, mode-changed athlete/application: Save is rejected before ever writing anything.
    const flip = await createAthlete("GUIDED");
    const planFlip = await seedProgram(flip.athleteProfileId, "prog-api-f-003-flip");
    const applicationFlip = await createBlockedApplication(flip.userId, planFlip.exerciseRef, planFlip.exerciseId);
    await db.update(athleteProfiles).set({ experienceMode: "ADAPTIVE" }).where(eq(athleteProfiles.id, flip.athleteProfileId));

    await expect(
      service.save({ userId: flip.userId, athleteProfileId: flip.athleteProfileId }, applicationFlip, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 }),
    ).rejects.toThrow(ConflictException);
  });

  it("PROG-API-F-004: Save is BOLA-safe (404 for a non-owning actor, no write occurs)", async () => {
    const athleteA = await createAthlete("GUIDED");
    const athleteB = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteA.athleteProfileId, "prog-api-f-004");
    const applicationId = await createBlockedApplication(athleteA.userId, plan.exerciseRef, plan.exerciseId);

    await expect(
      service.save({ userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 }),
    ).rejects.toThrow(NotFoundException);

    const [gym] = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteB.athleteProfileId));
    expect(gym).toBeUndefined(); // actor B's own gym profile was never created by this attempt
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW"); // A's application untouched
  });
});
