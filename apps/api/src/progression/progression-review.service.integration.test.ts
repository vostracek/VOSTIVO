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
import { createEntityId } from "@vostivo/domain";
import {
  bindExerciseToCapability,
  createLoadingCapability,
  ensureApplicationForDecision,
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";
import { ProgressionReviewService } from "./progression-review.service.js";

/**
 * Progression Application V1 — Slice D — real Postgres integration tests
 * for the API's own `ProgressionReviewService` (implementation task
 * "Slice D", task §61's "API contract tests"). Tests the service layer
 * directly against real Postgres (this codebase's own established
 * convention — see `plan.integration.test.ts`'s `new PlanReadService(db)`
 * — never a full HTTP-booted Nest app).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("ProgressionReviewService (real Postgres)", () => {
  let db: Database;
  let service: ProgressionReviewService;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
    service = new ProgressionReviewService(db);
  });

  async function createAthlete(experienceMode: "GUIDED" | "ADAPTIVE" | "EXPERT"): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode, unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function seedProgram(athleteProfileId: string, exerciseRef = "bench-press", loadAmountMilli = 100000): Promise<{ readonly exerciseId: string; readonly exerciseRef: string }> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: 1, status: "PLANNED" }).returning();
    const [exercise] = await db.insert(plannedExercises).values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: 1 }).returning();
    await db.insert(plannedSets).values({ id: createEntityId(), plannedExerciseId: exercise!.id, orderIndex: 1, targetRepsMin: 8, targetRepsMax: 12, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli, loadUnit: "KG", loadBasis: "TOTAL" });
    return { exerciseId: exercise!.id, exerciseRef };
  }

  async function createDecisionAndApplication(userId: string, exerciseRef: string, sourcePrescriptionExerciseId: string): Promise<string> {
    const workoutSessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db.insert(performedExercises).values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Bench Press", orderIndex: 1 });
    const decisionId = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionId,
      userId,
      exerciseRef,
      sourceWorkoutSessionId: workoutSessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId,
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
    return ensured.application.id;
  }

  async function setupCapability(athleteProfileId: string, exerciseRef: string, incrementAmountMilli = 2500): Promise<void> {
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli });
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, exerciseRef, created.loadingCapabilityId);
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

  // 13, 28
  it("PROG-API-D-001: GET pending returns the item for ADAPTIVE, but is empty for GUIDED even with a real PENDING row", async () => {
    const adaptive = await createAthlete("ADAPTIVE");
    const planA = await seedProgram(adaptive.athleteProfileId, "bench-adaptive");
    await setupCapability(adaptive.athleteProfileId, planA.exerciseRef);
    await createDecisionAndApplication(adaptive.userId, planA.exerciseRef, planA.exerciseId);

    const pendingAdaptive = await service.getPending({ userId: adaptive.userId, athleteProfileId: adaptive.athleteProfileId });
    expect(pendingAdaptive.applications).toHaveLength(1);
    expect(pendingAdaptive.applications[0]?.exerciseRef).toBe("bench-adaptive");
    // Slice E unblock task §7 — resolved from the real PlannedExercise at
    // this application's own Program Slot Identity, never a raw exerciseRef.
    expect(pendingAdaptive.applications[0]?.exerciseDisplayName).toBe("Bench Press");
    expect(pendingAdaptive.applications[0]?.proposalAvailable).toBe(true);
    expect(pendingAdaptive.applications[0]?.resolverProposedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    const guided = await createAthlete("GUIDED");
    const planB = await seedProgram(guided.athleteProfileId, "bench-guided-nocap");
    // No capability configured -> system apply fails -> stays PENDING_REVIEW as real domain state.
    await createDecisionAndApplication(guided.userId, planB.exerciseRef, planB.exerciseId);
    // Simulate the dispatch having already run and left it PENDING (missing capability).

    const pendingGuided = await service.getPending({ userId: guided.userId, athleteProfileId: guided.athleteProfileId });
    expect(pendingGuided.applications).toHaveLength(0); // task §28 — never exposed while GUIDED
  });

  // 27, 28
  it("PROG-API-D-002: GET proposal is available regardless of mode, and BOLA-safe", async () => {
    const athleteA = await createAthlete("ADAPTIVE");
    const athleteB = await createAthlete("ADAPTIVE");
    const plan = await seedProgram(athleteA.athleteProfileId);
    await setupCapability(athleteA.athleteProfileId, plan.exerciseRef);
    const applicationId = await createDecisionAndApplication(athleteA.userId, plan.exerciseRef, plan.exerciseId);

    const proposal = await service.getProposal({ userId: athleteA.userId, athleteProfileId: athleteA.athleteProfileId }, applicationId);
    expect(proposal.status).toBe("AVAILABLE");
    // Slice E final presentation-integrity gate — the proposal carries the
    // canonical exercise name resolved from this application's exact
    // Program Slot Identity, never the raw exerciseRef ("bench-press").
    if (proposal.status === "AVAILABLE") expect(proposal.exerciseDisplayName).toBe("Bench Press");

    await expect(service.getProposal({ userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId }, applicationId)).rejects.toThrow(NotFoundException);
  });

  // 15, 18, 22, 28
  it("PROG-API-D-003: POST apply succeeds for ADAPTIVE with a valid proposal, is rejected for GUIDED, and rejects a stale proposal read before a mode change", async () => {
    const adaptive = await createAthlete("ADAPTIVE");
    const planA = await seedProgram(adaptive.athleteProfileId, "bench-apply-adaptive");
    await setupCapability(adaptive.athleteProfileId, planA.exerciseRef);
    const appAId = await createDecisionAndApplication(adaptive.userId, planA.exerciseRef, planA.exerciseId);
    const proposalA = await service.getProposal({ userId: adaptive.userId, athleteProfileId: adaptive.athleteProfileId }, appAId);
    if (proposalA.status !== "AVAILABLE") throw new Error("expected AVAILABLE");

    const applyResult = await service.apply({ userId: adaptive.userId, athleteProfileId: adaptive.athleteProfileId }, appAId, {
      commandId: createEntityId(),
      expectedCurrentEffectiveLoad: proposalA.currentEffectiveLoad,
      expectedLoadingCapabilityId: proposalA.loadingCapabilityId,
      expectedLoadingCapabilityRevision: proposalA.loadingCapabilityRevision,
      expectedResolverProposedLoad: proposalA.resolverProposedLoad,
    });
    expect(applyResult).toEqual({ status: "APPLIED" });

    // GUIDED — the same command shape is rejected before ever touching the application.
    const guided = await createAthlete("GUIDED");
    const planB = await seedProgram(guided.athleteProfileId, "bench-apply-guided");
    await setupCapability(guided.athleteProfileId, planB.exerciseRef);
    const appBId = await createDecisionAndApplication(guided.userId, planB.exerciseRef, planB.exerciseId);
    await expect(
      service.apply({ userId: guided.userId, athleteProfileId: guided.athleteProfileId }, appBId, {
        commandId: createEntityId(),
        expectedCurrentEffectiveLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" },
        expectedLoadingCapabilityId: createEntityId(),
        expectedLoadingCapabilityRevision: 1,
        expectedResolverProposedLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" },
      }),
    ).rejects.toThrow(ConflictException);
    const [rowB] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appBId));
    expect(rowB?.status).toBe("PENDING_REVIEW"); // untouched by the rejected athlete attempt

    // Mode change GUIDED->ADAPTIVE after the proposal was read but before Apply — current mode wins (task §25).
    const flip = await createAthlete("ADAPTIVE");
    const planC = await seedProgram(flip.athleteProfileId, "bench-apply-flip");
    await setupCapability(flip.athleteProfileId, planC.exerciseRef);
    const appCId = await createDecisionAndApplication(flip.userId, planC.exerciseRef, planC.exerciseId);
    const proposalC = await service.getProposal({ userId: flip.userId, athleteProfileId: flip.athleteProfileId }, appCId);
    if (proposalC.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    await db.update(athleteProfiles).set({ experienceMode: "GUIDED" }).where(eq(athleteProfiles.id, flip.athleteProfileId));
    await expect(
      service.apply({ userId: flip.userId, athleteProfileId: flip.athleteProfileId }, appCId, {
        commandId: createEntityId(),
        expectedCurrentEffectiveLoad: proposalC.currentEffectiveLoad,
        expectedLoadingCapabilityId: proposalC.loadingCapabilityId,
        expectedLoadingCapabilityRevision: proposalC.loadingCapabilityRevision,
        expectedResolverProposedLoad: proposalC.resolverProposedLoad,
      }),
    ).rejects.toThrow(ConflictException);
  });

  // 16, 19
  it("PROG-API-D-004: POST keep-original succeeds for ADAPTIVE, is rejected for GUIDED", async () => {
    const adaptive = await createAthlete("ADAPTIVE");
    const planA = await seedProgram(adaptive.athleteProfileId, "bench-keep-adaptive");
    const appAId = await createDecisionAndApplication(adaptive.userId, planA.exerciseRef, planA.exerciseId);
    const keepResult = await service.keepOriginal({ userId: adaptive.userId, athleteProfileId: adaptive.athleteProfileId }, appAId, { commandId: createEntityId() });
    expect(keepResult).toEqual({ status: "KEPT_ORIGINAL" });

    const guided = await createAthlete("GUIDED");
    const planB = await seedProgram(guided.athleteProfileId, "bench-keep-guided");
    const appBId = await createDecisionAndApplication(guided.userId, planB.exerciseRef, planB.exerciseId);
    await expect(service.keepOriginal({ userId: guided.userId, athleteProfileId: guided.athleteProfileId }, appBId, { commandId: createEntityId() })).rejects.toThrow(ConflictException);
  });

  // 26, 29
  it("PROG-API-D-005: BOLA — actor B cannot Apply or Keep-Original actor A's application", async () => {
    const athleteA = await createAthlete("ADAPTIVE");
    const athleteB = await createAthlete("ADAPTIVE");
    const plan = await seedProgram(athleteA.athleteProfileId);
    await setupCapability(athleteA.athleteProfileId, plan.exerciseRef);
    const applicationId = await createDecisionAndApplication(athleteA.userId, plan.exerciseRef, plan.exerciseId);

    await expect(
      service.apply({ userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId }, applicationId, {
        commandId: createEntityId(),
        expectedCurrentEffectiveLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" },
        expectedLoadingCapabilityId: createEntityId(),
        expectedLoadingCapabilityRevision: 1,
        expectedResolverProposedLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" },
      }),
    ).rejects.toThrow(NotFoundException);

    await expect(service.keepOriginal({ userId: athleteB.userId, athleteProfileId: athleteB.athleteProfileId }, applicationId, { commandId: createEntityId() })).rejects.toThrow(NotFoundException);

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW");
  });
});
