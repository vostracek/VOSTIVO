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
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";
import { processProgressionApplicationDispatchJob } from "./progression-application-dispatch.job.js";

/**
 * Progression Application V1 — Slice D — real Postgres integration tests
 * for `processProgressionApplicationDispatchJob` (implementation task
 * "Slice D — Mode Authority + Durable Orchestration"). Run via
 * `pnpm test:integration`. Covers task §60's required test matrix — a
 * representative, hard-acceptance-criteria-focused subset (the same
 * methodology used for every prior slice's own evidence gate).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("processProgressionApplicationDispatchJob (real Postgres)", () => {
  let db: Database;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  async function createAthlete(experienceMode: "GUIDED" | "ADAPTIVE" | "EXPERT"): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode, unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  interface SlotFixture {
    readonly blockId: string;
    readonly versionId: string;
    readonly exerciseId: string;
    readonly exerciseRef: string;
  }

  async function seedProgram(athleteProfileId: string, exerciseRef = "bench-press", loadAmountMilli = 100000): Promise<SlotFixture> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db
      .insert(programVersions)
      .values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() })
      .returning();
    const [block] = await db
      .insert(trainingBlocks)
      .values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] })
      .returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: 1, status: "PLANNED" }).returning();
    const [exercise] = await db
      .insert(plannedExercises)
      .values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: 1 })
      .returning();
    await db.insert(plannedSets).values({
      id: createEntityId(),
      plannedExerciseId: exercise!.id,
      orderIndex: 1,
      targetRepsMin: 8,
      targetRepsMax: 12,
      setType: "WORKING",
      loadKind: "EXTERNAL_WEIGHT",
      loadAmountMilli,
      loadUnit: "KG",
      loadBasis: "TOTAL",
    });
    return { blockId: block!.id, versionId: version!.id, exerciseId: exercise!.id, exerciseRef };
  }

  async function createDecision(userId: string, exerciseRef: string, sourcePrescriptionExerciseId: string, decisionType: "INCREASE_LOAD" | "NO_CHANGE" = "INCREASE_LOAD"): Promise<string> {
    const workoutSessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db.insert(performedExercises).values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Bench Press", orderIndex: 1 });
    const id = createEntityId();
    await db.insert(progressionDecisions).values({
      id,
      userId,
      exerciseRef,
      sourceWorkoutSessionId: workoutSessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId,
      engine: "progression",
      policy: "v1",
      decisionType,
      reasonCode: decisionType === "INCREASE_LOAD" ? "TOP_OF_RANGE_ACHIEVED" : "PERFORMANCE_STABLE",
      evidenceStrength: "SUPPORTED",
      progressionStalled: false,
      recommendedChange: decisionType === "INCREASE_LOAD" ? { direction: "INCREASE_LOAD" } : null,
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });
    return id;
  }

  async function setupCapability(athleteProfileId: string, exerciseRef: string, incrementAmountMilli = 2500): Promise<void> {
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli });
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, exerciseRef, created.loadingCapabilityId);
  }

  afterEach(async () => {
    if (userIds.length === 0) return;

    // Command receipts are found via their application's userId, never via
    // their own userId column — a SYSTEM actor's receipt has userId = NULL
    // (task §13's truthful audit), so filtering by that column directly
    // would silently miss every SYSTEM receipt and leave it FK-blocking
    // the progression_applications delete below.
    const applicationRows = await db.select({ id: progressionApplications.id }).from(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    const applicationIds = applicationRows.map((r) => r.id);
    if (applicationIds.length > 0) {
      await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.applicationId, applicationIds));
    }
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

  // 9, 10
  it("PROG-APP-D-036: GUIDED + valid capability -> system APPLIED, actor audit = SYSTEM, actor user id NULL", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId);
    await setupCapability(athleteProfileId, plan.exerciseRef);
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

    const result = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
    expect(result.status).toBe("SYSTEM_APPLY_ATTEMPTED");
    if (result.status !== "SYSTEM_APPLY_ATTEMPTED") throw new Error("expected SYSTEM_APPLY_ATTEMPTED");
    expect(result.outcome).toBe("APPLIED");

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, result.applicationId));
    expect(row?.status).toBe("APPLIED");
    expect(row?.decidedByActorType).toBe("SYSTEM");
    expect(row?.decidedBy).toBeNull();
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    const [receipt] = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.applicationId, result.applicationId));
    expect(receipt?.actorType).toBe("SYSTEM");
    expect(receipt?.userId).toBeNull();
    expect(receipt?.outcome).toBe("APPLIED");
  });

  // 11, 12, 17
  it("PROG-APP-D-011: GUIDED + missing capability -> PENDING_REVIEW + durable REJECTED reason, job completes (no retry storm)", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId);
    // No capability configured at all.
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

    const result = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
    expect(result.status).toBe("SYSTEM_APPLY_ATTEMPTED");
    if (result.status !== "SYSTEM_APPLY_ATTEMPTED") throw new Error("expected SYSTEM_APPLY_ATTEMPTED");
    expect(result.outcome).toBe("NOT_APPLIED");
    expect(result.reason).toBe("LOADING_CAPABILITY_UNAVAILABLE");

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, result.applicationId));
    expect(row?.status).toBe("PENDING_REVIEW"); // recommendation stays valid/reviewable — task §17
    expect(row?.appliedAt).toBeNull();

    const [receipt] = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.applicationId, result.applicationId));
    expect(receipt?.actorType).toBe("SYSTEM");
    expect(receipt?.outcome).toBe("REJECTED");
    expect(receipt?.rejectionReason).toBe("LOADING_CAPABILITY_UNAVAILABLE");
    // The job itself never threw — no retry storm (task §8/§12).
  });

  // 13, 14
  it("PROG-APP-D-013: ADAPTIVE and EXPERT dispatch -> PENDING_REVIEW only, never auto-applied", async () => {
    for (const mode of ["ADAPTIVE", "EXPERT"] as const) {
      const { userId, athleteProfileId } = await createAthlete(mode);
      const plan = await seedProgram(athleteProfileId, `bench-${mode}`);
      await setupCapability(athleteProfileId, plan.exerciseRef);
      const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

      const result = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
      expect(result.status).toBe("LEFT_FOR_ATHLETE_REVIEW");
      if (result.status !== "LEFT_FOR_ATHLETE_REVIEW") throw new Error("expected LEFT_FOR_ATHLETE_REVIEW");

      const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, result.applicationId));
      expect(row?.status).toBe("PENDING_REVIEW");
      expect(row?.appliedAt).toBeNull();
    }
  });

  // 6
  it("PROG-APP-D-006: a NO_CHANGE decision produces NO application workflow at all", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId, "NO_CHANGE");

    const result = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
    expect(result.status).toBe("NO_APPLICATION");

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(0);
  });

  // 8, 23, 24 — duplicate dispatch jobs for the same decision
  it("PROG-APP-D-008: duplicate dispatch jobs for the same decision converge to one workflow and at most one effective APPLIED outcome", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId);
    await setupCapability(athleteProfileId, plan.exerciseRef);
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => processProgressionApplicationDispatchJob(createDatabaseClient(DATABASE_URL), { progressionDecisionId: decisionId, systemCommandId: createEntityId() })),
    );
    expect(results.every((r) => r.status === "SYSTEM_APPLY_ATTEMPTED")).toBe(true);

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(1); // exactly one workflow
    expect(rows[0]?.status).toBe("APPLIED"); // exactly one effective outcome — no corruption

    const appliedResults = results.filter((r) => r.status === "SYSTEM_APPLY_ATTEMPTED" && r.outcome === "APPLIED");
    expect(appliedResults.length).toBeGreaterThanOrEqual(1); // at least the winner (others converge to the same APPLIED outcome)
  });

  // Slice D — Final Durability / Crash-Window Gate §6/§13.D — duplicate
  // dispatch jobs for an ADAPTIVE/EXPERT decision must converge to
  // exactly one PENDING_REVIEW workflow, never a second row and never an
  // auto-apply. Same duplicate-dispatch shape as PROG-APP-D-008 above,
  // for the "left for athlete review" branch instead of GUIDED auto-apply.
  it("PROG-APP-D-DUR-ADAPTIVE-DUP: duplicate dispatch jobs for an ADAPTIVE decision converge to exactly one PENDING_REVIEW workflow", async () => {
    const { userId, athleteProfileId } = await createAthlete("ADAPTIVE");
    const plan = await seedProgram(athleteProfileId, "bench-adaptive-dup");
    await setupCapability(athleteProfileId, plan.exerciseRef);
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => processProgressionApplicationDispatchJob(createDatabaseClient(DATABASE_URL), { progressionDecisionId: decisionId, systemCommandId: createEntityId() })),
    );
    expect(results.every((r) => r.status === "LEFT_FOR_ATHLETE_REVIEW")).toBe(true);

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(1); // exactly one workflow
    expect(rows[0]?.status).toBe("PENDING_REVIEW"); // never auto-applied
    expect(rows[0]?.appliedAt).toBeNull();
  });

  // 20, 21 — mode-change races
  it("PROG-APP-D-020: mode GUIDED -> ADAPTIVE before dispatch runs prevents auto-apply; ADAPTIVE -> GUIDED before dispatch runs causes auto-apply", async () => {
    const athleteA = await createAthlete("GUIDED");
    const planA = await seedProgram(athleteA.athleteProfileId, "bench-mode-a");
    await setupCapability(athleteA.athleteProfileId, planA.exerciseRef);
    const decisionA = await createDecision(athleteA.userId, planA.exerciseRef, planA.exerciseId);
    // Mode changes BEFORE dispatch executes — current mode wins (task §4).
    await db.update(athleteProfiles).set({ experienceMode: "ADAPTIVE" }).where(eq(athleteProfiles.id, athleteA.athleteProfileId));

    const resultA = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionA, systemCommandId: createEntityId() });
    expect(resultA.status).toBe("LEFT_FOR_ATHLETE_REVIEW");

    const athleteB = await createAthlete("ADAPTIVE");
    const planB = await seedProgram(athleteB.athleteProfileId, "bench-mode-b");
    await setupCapability(athleteB.athleteProfileId, planB.exerciseRef);
    const decisionB = await createDecision(athleteB.userId, planB.exerciseRef, planB.exerciseId);
    await db.update(athleteProfiles).set({ experienceMode: "GUIDED" }).where(eq(athleteProfiles.id, athleteB.athleteProfileId));

    const resultB = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionB, systemCommandId: createEntityId() });
    expect(resultB.status).toBe("SYSTEM_APPLY_ATTEMPTED");
    if (resultB.status !== "SYSTEM_APPLY_ATTEMPTED") throw new Error("expected SYSTEM_APPLY_ATTEMPTED");
    expect(resultB.outcome).toBe("APPLIED");
  });

  // 25 — system apply uses the exact Slice-C capability/effective-load path
  it("PROG-APP-D-025: system apply's numeric result matches exactly what the Slice-C mechanics would compute for the same inputs", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "bench-numeric", 100000);
    await setupCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision(userId, plan.exerciseRef, plan.exerciseId);

    const result = await processProgressionApplicationDispatchJob(db, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
    if (result.status !== "SYSTEM_APPLY_ATTEMPTED") throw new Error("expected SYSTEM_APPLY_ATTEMPTED");
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, result.applicationId));
    // 100000 authored + 2500 increment = 102500, identical to every Slice-C athlete-Apply proof.
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    expect(row?.loadingCapabilitySnapshot).toEqual({ kind: "FIXED_INCREMENT", unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
  });
});
