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
import { getOrCreateDefaultGymProfileForAthlete } from "./gym-profile.js";
import { bindExerciseToCapability, createLoadingCapability } from "./loading-capability-write.js";
import { ensureApplicationForDecision } from "./progression-application.js";
import { applySystemProgression } from "./progression-application-apply.js";
import { getGuidedLoadingSetupAttention, getLoadingSetupContext, saveGuidedLoadingSetup } from "./guided-loading-setup.js";

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1) — real Postgres integration
 * tests. Run via `pnpm test:integration`. A representative,
 * hard-acceptance-criteria-focused subset of the task's own 28-item
 * backend test matrix (this codebase's own established methodology for
 * large matrices) — every item explicitly called out as MANDATORY by the
 * task itself (shared-capability safety §33, identical-config reuse §34,
 * the fixed-increment/enumerated-list end-to-end examples §31/§32, and
 * §16's binding-race proof) is proven directly.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("Progression Application V1 — Slice F Guided loading setup (real Postgres)", () => {
  let db: Database;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  async function createAthlete(experienceMode: ExperienceMode): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode, unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  interface SlotFixture {
    readonly exerciseId: string;
    readonly exerciseRef: string;
  }

  async function seedProgram(athleteProfileId: string, exerciseRef: string, loadAmountMilli = 100000): Promise<SlotFixture> {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: 1, status: "PLANNED" }).returning();
    const [exercise] = await db.insert(plannedExercises).values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Incline Dumbbell Press", orderIndex: 1 }).returning();
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
    return { exerciseId: exercise!.id, exerciseRef };
  }

  async function createDecision(userId: string, exerciseRef: string, sourcePrescriptionExerciseId: string): Promise<string> {
    const workoutSessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db.insert(performedExercises).values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Incline Dumbbell Press", orderIndex: 1 });
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
      decisionType: "INCREASE_LOAD",
      reasonCode: "TOP_OF_RANGE_ACHIEVED",
      evidenceStrength: "SUPPORTED",
      progressionStalled: false,
      recommendedChange: { direction: "INCREASE_LOAD" },
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });
    return id;
  }

  async function ensureAndGetId(userId: string, decisionId: string): Promise<string> {
    const outcome = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (outcome.status !== "CREATED" && outcome.status !== "ALREADY_EXISTS") throw new Error(`expected CREATED/ALREADY_EXISTS, got ${outcome.status}`);
    return outcome.application.id;
  }

  /** Creates a GUIDED, PENDING_REVIEW application already left blocked by a REAL dispatch-shaped SYSTEM Apply attempt — never a hand-inserted fake command row. */
  async function createBlockedGuidedApplication(userId: string, exerciseRef: string, exerciseId: string): Promise<string> {
    const decisionId = await createDecision(userId, exerciseRef, exerciseId);
    const applicationId = await ensureAndGetId(userId, decisionId);
    await applySystemProgression(db, { applicationId, systemCommandId: createEntityId() });
    return applicationId;
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

  // 1, 6
  it("SLICE-F-001: a GUIDED blocked application (no capability at all) surfaces as recovery attention with the canonical display name", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-001");
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const item = await getGuidedLoadingSetupAttention(db, { userId });
    expect(item).not.toBeNull();
    expect(item?.applicationId).toBe(applicationId);
    expect(item?.exerciseDisplayName).toBe("Incline Dumbbell Press");
    expect(item?.recoverableReason).toBe("LOADING_CAPABILITY_UNAVAILABLE");
  });

  // 2, 3
  it("SLICE-F-002: ADAPTIVE/EXPERT applications never surface in the Guided recovery query, even if somehow PENDING_REVIEW", async () => {
    for (const mode of ["ADAPTIVE", "EXPERT"] as const) {
      const { userId, athleteProfileId } = await createAthlete(mode);
      const plan = await seedProgram(athleteProfileId, `slice-f-002-${mode}`);
      await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

      const item = await getGuidedLoadingSetupAttention(db, { userId });
      expect(item).toBeNull();
    }
  });

  // 5
  it("SLICE-F-003: a STALE application never surfaces, even with a prior recoverable rejection", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-003");
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    // The Plan changed underneath the still-pending application.
    const [row] = await db.select({ programVersionId: progressionApplications.programVersionId }).from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    const programVersionId = row!.programVersionId;
    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, programVersionId));

    const item = await getGuidedLoadingSetupAttention(db, { userId });
    expect(item).toBeNull();
  });

  // 7, 8, 9, 10
  it("SLICE-F-004: FIXED_INCREMENT setup creates the default GymProfile lazily (never on GET), and creates a correctly-scoped capability + exact binding", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-004", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const beforeGet = await getLoadingSetupContext(db, { userId }, applicationId);
    expect(beforeGet.status).toBe("AVAILABLE");
    const [gymBeforeGet] = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(gymBeforeGet).toBeUndefined(); // task §12/#8 — GET never creates a GymProfile

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(outcome.status).toBe("APPLIED");

    const [gym] = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(gym).toBeDefined();
    expect(gym?.isDefault).toBe(true);

    const [binding] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef));
    expect(binding).toBeDefined();
    const [capability] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, binding!.loadingCapabilityId));
    expect(capability?.kind).toBe("FIXED_INCREMENT");
    expect(capability?.fixedIncrementAmountMilli).toBe(2500);
    expect(capability?.unit).toBe("KG");
    expect(capability?.basis).toBe("TOTAL");

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("APPLIED");
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
  });

  // 21, 22 (fixed-increment worked example, task §31)
  it("SLICE-F-005 (task §31 worked example): 100kg TOTAL, no capability, 2.5kg fixed increment -> APPLIED at 102.5kg, audited as SYSTEM", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-005", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(outcome).toEqual({ status: "APPLIED" });

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    expect(row?.decidedByActorType).toBe("SYSTEM");
    expect(row?.decidedBy).toBeNull();

    const receipts = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.applicationId, applicationId));
    expect(receipts).toHaveLength(2); // the original REJECTED attempt, plus this successful retry
    expect(receipts.every((r) => r.actorType === "SYSTEM" && r.userId === null)).toBe(true);
    expect(receipts.some((r) => r.outcome === "APPLIED")).toBe(true);
  });

  // 11, 22, 25 (enumerated-list worked example, task §32, plus §22/§25's "physically valid but no next" case)
  it("SLICE-F-006 (task §32 worked example): 24kg PER_IMPLEMENT enumerated list -> APPLIED at 26kg; a list whose top IS the current load stays blocked with NO_SUITABLE_INCREMENT, never inventing a value", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-006", 24000);
    await db.update(plannedSets).set({ loadBasis: "PER_IMPLEMENT" }).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "ENUMERATED_LIST", loadsMilli: [20000, 22000, 24000, 26000, 28000] });
    expect(outcome).toEqual({ status: "APPLIED" });
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 26000, unit: "KG", basis: "PER_IMPLEMENT" });

    // Second application, same athlete/plan shape, but the list's own top IS the current load.
    const plan2 = await seedProgram(athleteProfileId, "slice-f-006-blocked", 30000);
    await db.update(plannedSets).set({ loadBasis: "PER_IMPLEMENT" }).where(eq(plannedSets.plannedExerciseId, plan2.exerciseId));
    const applicationId2 = await createBlockedGuidedApplication(userId, plan2.exerciseRef, plan2.exerciseId);

    const outcome2 = await saveGuidedLoadingSetup(db, { userId }, applicationId2, { kind: "ENUMERATED_LIST", loadsMilli: [20000, 25000, 30000] });
    expect(outcome2).toEqual({ status: "SAVED_STILL_BLOCKED", reason: "NO_SUITABLE_INCREMENT" });
    const [row2] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId2));
    expect(row2?.status).toBe("PENDING_REVIEW"); // config saved, progression itself remains blocked — never invented
  });

  // 33 — MANDATORY shared-capability safety proof
  it("SLICE-F-007 (task §33, mandatory): editing Exercise A's loading never mutates a capability shared with Exercise B, and A gets its own new capability", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const sharedCapability = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 5000 });
    if (sharedCapability.status !== "CREATED") throw new Error("expected CREATED");

    const planA = await seedProgram(athleteProfileId, "slice-f-007-a", 100000);
    const planB = await seedProgram(athleteProfileId, "slice-f-007-b", 100000);
    await bindExerciseToCapability(db, gym.id, planA.exerciseRef, sharedCapability.loadingCapabilityId);
    await bindExerciseToCapability(db, gym.id, planB.exerciseRef, sharedCapability.loadingCapabilityId);

    // A's own bound capability is a 5kg fixed increment, but its own current
    // load (100kg) makes 5kg... actually a perfectly valid increment — force
    // a REAL block for A instead via an incompatible basis mismatch so a
    // real SYSTEM rejection (CAPABILITY_INCOMPATIBLE) exists to recover from.
    await db.update(plannedSets).set({ loadBasis: "PER_IMPLEMENT" }).where(eq(plannedSets.plannedExerciseId, planA.exerciseId));
    const applicationA = await createBlockedGuidedApplication(userId, planA.exerciseRef, planA.exerciseId);

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationA, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(outcome).toEqual({ status: "APPLIED" });

    // The shared capability C itself is untouched.
    const [capabilityAfter] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, sharedCapability.loadingCapabilityId));
    expect(capabilityAfter?.fixedIncrementAmountMilli).toBe(5000);
    expect(capabilityAfter?.basis).toBe("TOTAL");

    // B remains bound to the original, unchanged capability.
    const [bindingB] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, planB.exerciseRef));
    expect(bindingB?.loadingCapabilityId).toBe(sharedCapability.loadingCapabilityId);

    // A is now bound to a DIFFERENT, brand-new capability.
    const [bindingA] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, planA.exerciseRef));
    expect(bindingA?.loadingCapabilityId).not.toBe(sharedCapability.loadingCapabilityId);
    const [capabilityA] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, bindingA!.loadingCapabilityId));
    expect(capabilityA?.basis).toBe("PER_IMPLEMENT");
    expect(capabilityA?.fixedIncrementAmountMilli).toBe(2500);
  });

  // 14, 34 — MANDATORY identical-config reuse proof
  it("SLICE-F-008 (task §34, mandatory): a second, later application for the SAME exact exercise submitting a semantically identical configuration reuses the already-bound capability — no duplicate row, binding unchanged", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const exerciseRef = "slice-f-008-shared-ref";
    // Two independent Program Slot Identities that both happen to bind the
    // SAME exact exerciseRef (e.g. two separate progression events for the
    // same exercise over time) — capability binding is keyed by
    // `(gymProfileId, exerciseRef)`, never by Program Slot Identity, so
    // this is the realistic shape task §34's "Exercise A already bound...
    // athlete submits a semantically identical setup" scenario actually
    // takes once the FIRST application is no longer PENDING_REVIEW.
    const planA = await seedProgram(athleteProfileId, exerciseRef, 100000);
    const planB = await seedProgram(athleteProfileId, exerciseRef, 100000);
    // Both blocked BEFORE any capability exists for this exerciseRef —
    // otherwise B's own dispatch-shaped system-apply attempt would already
    // succeed against A's just-created capability (the exact same
    // "working capability benefits every future decision" behavior this
    // whole slice exists to produce), leaving nothing left for B's own
    // Save call to recover.
    const applicationA = await createBlockedGuidedApplication(userId, planA.exerciseRef, planA.exerciseId);
    const applicationB = await createBlockedGuidedApplication(userId, planB.exerciseRef, planB.exerciseId);

    const first = await saveGuidedLoadingSetup(db, { userId }, applicationA, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(first).toEqual({ status: "APPLIED" });
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const capabilitiesAfterFirst = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.gymProfileId, gym.id));
    expect(capabilitiesAfterFirst).toHaveLength(1);
    const boundIdAfterFirst = (await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, exerciseRef)))[0]!.loadingCapabilityId;

    // B, still PENDING_REVIEW/blocked, submitting the exact same
    // configuration, must reuse the already-bound capability (created by
    // A's Save moments ago) rather than creating a duplicate.
    const second = await saveGuidedLoadingSetup(db, { userId }, applicationB, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(second).toEqual({ status: "APPLIED" });

    const capabilitiesAfterSecond = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.gymProfileId, gym.id));
    const boundIdAfterSecond = (await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, exerciseRef)))[0]!.loadingCapabilityId;

    expect(capabilitiesAfterSecond).toHaveLength(1); // no new row created by the second, identical submission
    expect(boundIdAfterSecond).toBe(boundIdAfterFirst); // same capability id, never re-bound to a new row
  });

  // 15, 16
  it("SLICE-F-009: BOLA — actor B cannot read actor A's attention item, read A's setup context, or write A's configuration", async () => {
    const athleteA = await createAthlete("GUIDED");
    const athleteB = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteA.athleteProfileId, "slice-f-009");
    const applicationId = await createBlockedGuidedApplication(athleteA.userId, plan.exerciseRef, plan.exerciseId);

    const bItem = await getGuidedLoadingSetupAttention(db, { userId: athleteB.userId });
    expect(bItem).toBeNull();

    const bContext = await getLoadingSetupContext(db, { userId: athleteB.userId }, applicationId);
    expect(bContext.status).toBe("NOT_FOUND");

    const bSave = await saveGuidedLoadingSetup(db, { userId: athleteB.userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(bSave.status).toBe("NOT_FOUND");

    // A's own application is completely untouched by B's attempts.
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW");
  });

  // 18
  it("SLICE-F-010: mode change to ADAPTIVE before Save is rejected as MODE_ACTION_NOT_ALLOWED — Guided recovery never runs under stale authority", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-010");
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    await db.update(athleteProfiles).set({ experienceMode: "ADAPTIVE" }).where(eq(athleteProfiles.id, athleteProfileId));

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(outcome).toEqual({ status: "MODE_ACTION_NOT_ALLOWED" });

    const [gym] = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(gym).toBeUndefined(); // no configuration was written at all
  });

  // 19
  it("SLICE-F-011: the Plan changing (ProgramVersion superseded) before Save is rejected as NOT_RECOVERABLE — never configures a stale application", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-011");
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);
    const [row] = await db.select({ programVersionId: progressionApplications.programVersionId }).from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    const programVersionId = row!.programVersionId;

    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, programVersionId));

    const outcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(outcome).toEqual({ status: "NOT_RECOVERABLE" });
  });

  // 20 — MANDATORY real-Postgres binding-race proof (task §16, new binding-update path)
  it("SLICE-F-012 (task §16, mandatory): two concurrent identical Save attempts on the same exact exercise binding never deadlock and converge to one capability", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-012", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        saveGuidedLoadingSetup(createDatabaseClient(DATABASE_URL), { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 }),
      ),
    );
    // No deadlock (the test itself would time out if one occurred); every
    // attempt reaches a terminal, well-formed outcome.
    expect(results.every((r) => r.status === "APPLIED" || r.status === "SAVED_STILL_BLOCKED")).toBe(true);

    const capabilities = await db
      .select()
      .from(loadingCapabilities)
      .where(eq(loadingCapabilities.gymProfileId, (await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId)).id));
    expect(capabilities).toHaveLength(1); // exactly one capability, never a duplicate from the race

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("APPLIED"); // exactly one effective outcome — no corruption
  });

  // Slice F — Final Save-vs-Apply Serialization Gate, task §4/§5 (mandatory).
  // A genuine real-Postgres race between contextual SAVE and SYSTEM numeric
  // Apply for the EXACT SAME binding/capability row — never a Save-vs-Save
  // race (already proven above). `raceDelayMs` biases which side reaches
  // the shared `resolveBoundCapabilityForUpdate` lock first: real
  // transactions, real locks, no mocking of locking itself (task §4's own
  // explicit "no mocks for locking") — the delay only affects which side's
  // real network round-trips start first, nothing about how Postgres
  // resolves the resulting contention.
  const raceDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("SLICE-F-015 (task §5, mandatory): SAVE wins the binding/capability lock race -> the subsequent SYSTEM Apply resolves against the NEW canonical capability", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-015", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    // "Configuration A previously saved" (task §4's own suggested fixture
    // shape) — Capability A bound directly, application still
    // PENDING_REVIEW (no apply attempt has run against it yet).
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const capabilityA = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capabilityA.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, plan.exerciseRef, capabilityA.loadingCapabilityId);

    const [saveResult, applyResult] = await Promise.all([
      saveGuidedLoadingSetup(createDatabaseClient(DATABASE_URL), { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 5000 }),
      raceDelay(25).then(() => applySystemProgression(createDatabaseClient(DATABASE_URL), { applicationId, systemCommandId: createEntityId() })),
    ]);

    expect(saveResult).toEqual({ status: "APPLIED" });
    // Whichever Apply attempt actually lands it (Save's own internal retry,
    // or this test's externally-raced one) — both share the exact same
    // idempotent core (task §17), so either a fresh APPLIED or a
    // converging NOT_APPLIED-on-an-already-terminal-application is valid;
    // never NOT_FOUND/COMMAND_CONFLICT.
    expect(applyResult.status === "APPLIED" || applyResult.status === "NOT_APPLIED").toBe(true);

    const [binding] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef));
    expect(binding?.loadingCapabilityId).not.toBe(capabilityA.loadingCapabilityId); // rebound to a NEW capability B

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("APPLIED");
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 105000, unit: "KG", basis: "TOTAL" }); // 100 + 5, never 102.5 — audit/binding stay coherent
    expect(row?.loadingCapabilitySnapshot).toEqual({ kind: "FIXED_INCREMENT", unit: "KG", basis: "TOTAL", incrementAmountMilli: 5000 });
  });

  it("SLICE-F-016 (task §6, mandatory): APPLY wins the binding/capability lock race -> contextual SAVE's post-lock revalidation blocks it, never rebinding an already-resolved application", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-016", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const capabilityA = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capabilityA.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, plan.exerciseRef, capabilityA.loadingCapabilityId);

    const [applyResult, saveResult] = await Promise.all([
      applySystemProgression(createDatabaseClient(DATABASE_URL), { applicationId, systemCommandId: createEntityId() }),
      raceDelay(25).then(() => saveGuidedLoadingSetup(createDatabaseClient(DATABASE_URL), { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 5000 })),
    ]);

    expect(applyResult.status).toBe("APPLIED");
    // The MANDATORY post-lock revalidation (task §2) must have observed
    // the application was no longer PENDING_REVIEW by the time SAVE's own
    // transaction finally acquired the lock Apply had just released — a
    // deterministic non-actionable result, never a rebind.
    expect(saveResult).toEqual({ status: "NOT_RECOVERABLE" });

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("APPLIED");
    expect(row?.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" }); // 100 + 2.5 (A), never 105 (B)
    expect(row?.loadingCapabilitySnapshot).toEqual({ kind: "FIXED_INCREMENT", unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });

    const [binding] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef));
    expect(binding?.loadingCapabilityId).toBe(capabilityA.loadingCapabilityId); // binding remains A — never overwritten after recovery already completed

    const capabilities = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.gymProfileId, gym.id));
    expect(capabilities).toHaveLength(1); // capability B was never even created — SAVE aborted before reaching that step
  });

  // 26, 27 — configuration durability across a transient retry failure
  it("SLICE-F-013 (task §19/§26/§27): a transient failure during the SYSTEM retry leaves the configuration saved; a subsequent Retry reuses it and can succeed", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-013", 100000);
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    // Narrow test-only fault-injection seam (same methodology as the
    // Slice D durability gate): `saveGuidedLoadingSetup`'s config-write
    // transaction is the first `db.transaction()` call reached; the
    // shared `applySystemProgression` core's own internal transaction is
    // the second. Failing only the second call proves the already-saved
    // configuration survives a genuinely transient retry failure — no
    // production code changes for this.
    let transactionCallCount = 0;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (...args: Parameters<Database["transaction"]>) => {
            transactionCallCount += 1;
            if (transactionCallCount === 2) throw new Error("SIMULATED_TRANSIENT_RETRY_FAILURE");
            return target.transaction(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const flakyOutcome = await saveGuidedLoadingSetup(flakyDb, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(flakyOutcome).toEqual({ status: "SAVED_RETRY_FAILED" });

    // The configuration itself is durably saved despite the retry failure.
    const [binding] = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef));
    expect(binding).toBeDefined();
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW"); // still recoverable — never lost

    // Retry, with the fault already consumed and no new configuration data
    // required from the athlete, reuses the saved capability and succeeds.
    const retryOutcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 });
    expect(retryOutcome).toEqual({ status: "APPLIED" });

    const capabilitiesAfter = await db
      .select()
      .from(loadingCapabilities)
      .where(eq(loadingCapabilities.gymProfileId, (await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId)).id));
    expect(capabilitiesAfter).toHaveLength(1); // the retry reused the already-saved capability, never a duplicate
  });

  // Input validation — never reaches Postgres
  it("SLICE-F-014: a non-positive fixed increment and a non-ascending enumerated list are both rejected before any write", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "slice-f-014");
    const applicationId = await createBlockedGuidedApplication(userId, plan.exerciseRef, plan.exerciseId);

    const zeroOutcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 0 });
    expect(zeroOutcome).toEqual({ status: "INVALID_FIXED_INCREMENT" });

    const badListOutcome = await saveGuidedLoadingSetup(db, { userId }, applicationId, { kind: "ENUMERATED_LIST", loadsMilli: [20000, 20000, 25000] });
    expect(badListOutcome).toEqual({ status: "INVALID_ENUMERATED_LIST", reason: "NOT_STRICTLY_ASCENDING" });

    const [gym] = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(gym).toBeUndefined(); // neither invalid submission wrote anything
  });
});
