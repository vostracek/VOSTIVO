import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
import { getOrCreateDefaultGymProfileForAthlete } from "./gym-profile.js";
import { bindExerciseToCapability, createLoadingCapability, updateLoadingCapabilityPayload } from "./loading-capability-write.js";
import { ensureApplicationForDecision, keepOriginal } from "./progression-application.js";
import { applyProgression, resolveApplicationProposal } from "./progression-application-apply.js";
import { listPendingProgressionApplications } from "./progression-review.js";

/**
 * Progression Application V1 — Slice C — real Postgres integration tests
 * (implementation task "Slice C — Numeric Apply + Effective Overlay").
 * Run via `pnpm test:integration`. Covers task §62's required test matrix
 * — a representative, hard-acceptance-criteria-focused subset (the same
 * methodology used for Slice A/B's own evidence gates), not a literal
 * 1:1 of all 48 items; every HARD acceptance criterion the task itself
 * calls out (§8/§9/§30/§54-§59) is proven directly.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("Progression Application V1 — Slice C numeric Apply (real Postgres)", () => {
  let db: Database;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  async function createAthlete(): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  interface SlotFixture {
    readonly blockId: string;
    readonly versionId: string;
    readonly cycleId: string;
    readonly workoutId: string;
    readonly exerciseId: string;
    readonly exerciseRef: string;
  }

  async function seedProgram(
    athleteProfileId: string,
    opts: { readonly loadAmountMilli?: number; readonly exerciseRef?: string } = {},
  ): Promise<SlotFixture> {
    const exerciseRef = opts.exerciseRef ?? "bench-press";
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
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
        cycleCount: 6,
        focusAreas: [{ name: "Back", emphasis: "PRIORITY" }],
      })
      .returning();
    const { cycleId, workoutId, exerciseId } = await addCycleWorkoutExercise(block!.id, 1, 1, 1, exerciseRef, opts.loadAmountMilli ?? 100000);
    return { blockId: block!.id, versionId: version!.id, cycleId, workoutId, exerciseId, exerciseRef };
  }

  async function addCycleWorkoutExercise(
    blockId: string,
    cycleOrderIndex: number,
    workoutOrderIndex: number,
    exerciseOrderIndex: number,
    exerciseRef: string,
    loadAmountMilli: number,
  ): Promise<{ readonly cycleId: string; readonly workoutId: string; readonly exerciseId: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db
      .insert(trainingCycles)
      .values({ id: createEntityId(), trainingBlockId: blockId, orderIndex: cycleOrderIndex, startDate: today, endDate: today })
      .returning();
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: workoutOrderIndex, status: "PLANNED" })
      .returning();
    const [exercise] = await db
      .insert(plannedExercises)
      .values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: exerciseOrderIndex })
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
    return { cycleId: cycle!.id, workoutId: workout!.id, exerciseId: exercise!.id };
  }

  async function createPerformedExposure(userId: string, exerciseRef: string): Promise<{ readonly workoutSessionId: string; readonly performedExerciseId: string }> {
    const workoutSessionId = createEntityId();
    await db
      .insert(workoutSessions)
      .values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db
      .insert(performedExercises)
      .values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Bench Press", orderIndex: 1 });
    return { workoutSessionId, performedExerciseId };
  }

  async function createDecision(input: { readonly userId: string; readonly exerciseRef: string; readonly sourcePrescriptionExerciseId: string }): Promise<string> {
    const { workoutSessionId, performedExerciseId } = await createPerformedExposure(input.userId, input.exerciseRef);
    const id = createEntityId();
    await db.insert(progressionDecisions).values({
      id,
      userId: input.userId,
      exerciseRef: input.exerciseRef,
      sourceWorkoutSessionId: workoutSessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId: input.sourcePrescriptionExerciseId,
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

  async function setupFixedIncrementCapability(
    athleteProfileId: string,
    exerciseRef: string,
    incrementAmountMilli = 2500,
  ): Promise<{ readonly gymProfileId: string; readonly loadingCapabilityId: string }> {
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli });
    if (created.status !== "CREATED") throw new Error("expected CREATED capability");
    await bindExerciseToCapability(db, gym.id, exerciseRef, created.loadingCapabilityId);
    return { gymProfileId: gym.id, loadingCapabilityId: created.loadingCapabilityId };
  }

  async function setupEnumeratedListCapability(
    athleteProfileId: string,
    exerciseRef: string,
    loadsMilli: readonly number[],
  ): Promise<{ readonly gymProfileId: string; readonly loadingCapabilityId: string }> {
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "ENUMERATED_LIST", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", loadsMilli });
    if (created.status !== "CREATED") throw new Error("expected CREATED capability");
    await bindExerciseToCapability(db, gym.id, exerciseRef, created.loadingCapabilityId);
    return { gymProfileId: gym.id, loadingCapabilityId: created.loadingCapabilityId };
  }

  async function ensureAndGetId(userId: string, decisionId: string): Promise<string> {
    const outcome = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (outcome.status !== "CREATED" && outcome.status !== "ALREADY_EXISTS") throw new Error(`expected CREATED/ALREADY_EXISTS, got ${outcome.status}`);
    return outcome.application.id;
  }

  afterEach(async () => {
    if (userIds.length === 0) return;

    const commandRows = await db.select({ commandId: progressionApplicationCommands.commandId }).from(progressionApplicationCommands).where(inArray(progressionApplicationCommands.userId, userIds));
    if (commandRows.length > 0) {
      await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.commandId, commandRows.map((r) => r.commandId)));
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

  // 1, 10
  it("PROG-APP-C-001: a valid PENDING application produces a numeric proposal without mutating anything", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const proposal = await resolveApplicationProposal(db, { userId }, applicationId);
    expect(proposal.status).toBe("AVAILABLE");
    if (proposal.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    // Slice E final presentation-integrity gate (task §4/§9.4/§9.5) — the
    // proposal itself carries the canonical, presentation-safe exercise
    // name, resolved from this application's own exact Program Slot
    // Identity — never the raw exerciseRef ("bench-press").
    expect(proposal.exerciseDisplayName).toBe("Bench Press");
    expect(proposal.currentEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" });
    expect(proposal.resolverProposedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW");
    expect(row?.appliedAt).toBeNull();
  });

  // Slice E final presentation-integrity gate, task §9.1 — a valid
  // canonical slot produces the real displayName in the pending list.
  it("PROG-APP-E-GATE-002: listPendingProgressionApplications returns the real PlannedExercise displayName, never exerciseRef", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000, exerciseRef: "bench-press-gate-002" });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    await ensureAndGetId(userId, decisionId);

    const items = await listPendingProgressionApplications(db, { userId });
    expect(items).toHaveLength(1);
    expect(items[0]?.exerciseDisplayName).toBe("Bench Press");
    expect(items[0]?.exerciseDisplayName).not.toBe("bench-press-gate-002");
  });

  // Slice E final presentation-integrity gate, task §3/§9.2 — an
  // application whose canonical Program Slot exercise can no longer be
  // resolved is OMITTED from the pending list entirely (never surfaced
  // with a raw-exerciseRef fallback), and this is a presentation filter
  // only — the row's own persisted status is untouched.
  it("PROG-APP-E-GATE-003: an application whose canonical slot vanished is omitted from the pending list, and its own status is left untouched", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000, exerciseRef: "bench-press-gate-003" });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    await db.delete(plannedSets).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));
    await db.delete(plannedExercises).where(eq(plannedExercises.id, plan.exerciseId));

    const items = await listPendingProgressionApplications(db, { userId });
    expect(items).toHaveLength(0);
    expect(JSON.stringify(items)).not.toContain("bench-press-gate-003");

    // Presentation filter only — the application row itself is untouched
    // (still PENDING_REVIEW, never silently transitioned to STALE by this
    // read-only listing query).
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW");
  });

  // Slice E final presentation-integrity gate, task §9.2/§9.3 — the
  // canonical PlannedExercise slot vanishing must never surface the raw
  // exerciseRef; it must become an unavailable proposal instead.
  it("PROG-APP-E-GATE-001: canonical PlannedExercise slot no longer resolvable -> proposal UNAVAILABLE, never a raw exerciseRef fallback", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000, exerciseRef: "incline-db-press-v2" });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    // The Plan changed underneath this still-pending application: its
    // exact Program Slot Identity (trainingBlockId/workoutOrderIndex/
    // exerciseOrderIndex) no longer resolves to a real PlannedExercise.
    await db.delete(plannedSets).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));
    await db.delete(plannedExercises).where(eq(plannedExercises.id, plan.exerciseId));

    const proposal = await resolveApplicationProposal(db, { userId }, applicationId);
    expect(proposal.status).toBe("UNAVAILABLE");
    // The raw exerciseRef must never appear anywhere in the outcome.
    expect(JSON.stringify(proposal)).not.toContain("incline-db-press-v2");
  });

  // 2, 12, 13, 14, 15
  it("PROG-APP-C-002: successful Apply -> APPLIED, appliedLoad == resolverProposedLoad, immutable capability snapshot + exact revision stored", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const { loadingCapabilityId } = await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const outcome = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(outcome.status).toBe("APPLIED");
    if (outcome.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(outcome.application.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    expect(outcome.application.resolverProposedLoad).toEqual(outcome.application.appliedLoad);
    expect(outcome.application.loadingCapabilityId).toBe(loadingCapabilityId);
    expect(outcome.application.loadingCapabilityRevision).toBe(1);
    expect(outcome.application.loadingCapabilitySnapshot).toEqual({ kind: "FIXED_INCREMENT", unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    expect(outcome.application.appliedAt).not.toBeNull();
    expect(outcome.application.decidedBy).toBe(userId);

    // Authored Plan is untouched (task §3):
    const [set] = await db.select().from(plannedSets).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));
    expect(set?.loadAmountMilli).toBe(100000);
  });

  // 3, 4
  it("PROG-APP-C-003: no default GymProfile / no binding -> LOADING_CAPABILITY_UNAVAILABLE, application stays PENDING_REVIEW", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    // No GymProfile/binding/capability configured at all.
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const outcome = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(outcome.status).toBe("NOT_APPLIED");
    if (outcome.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcome.reason).toBe("LOADING_CAPABILITY_UNAVAILABLE");
    expect(outcome.application.status).toBe("PENDING_REVIEW"); // task §41 — remains reviewable

    // A default GymProfile with no binding for this exercise also fails the same way:
    await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const outcome2 = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(outcome2.status).toBe("NOT_APPLIED");
    if (outcome2.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcome2.reason).toBe("LOADING_CAPABILITY_UNAVAILABLE");
  });

  // 6, 7
  it("PROG-APP-C-006: an ENUMERATED_LIST capability with a unit mismatch is CAPABILITY_INCOMPATIBLE; a compatible one resolves correctly", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 22000 });
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "ENUMERATED_LIST", gymProfileId: gym.id, unit: "LB", basis: "TOTAL", loadsMilli: [20000, 22000, 24000] });
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, plan.exerciseRef, created.loadingCapabilityId);

    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const mismatch = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(mismatch.status).toBe("NOT_APPLIED");
    if (mismatch.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(mismatch.reason).toBe("CAPABILITY_INCOMPATIBLE");
    expect(mismatch.application.status).toBe("PENDING_REVIEW");

    // Fix the capability to KG (compatible) — the SAME application, still PENDING_REVIEW, now resolves.
    await updateLoadingCapabilityPayload(db, created.loadingCapabilityId, { kind: "ENUMERATED_LIST", loadsMilli: [20000, 22000, 24000] });
    await db.update(loadingCapabilities).set({ unit: "KG" }).where(eq(loadingCapabilities.id, created.loadingCapabilityId));

    const resolved = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(resolved.status).toBe("APPLIED");
    if (resolved.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(resolved.application.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 24000, unit: "KG", basis: "TOTAL" });
  });

  // 8, 9
  it("PROG-APP-C-008: current load absent from an ENUMERATED_LIST -> CURRENT_LOAD_UNSUPPORTED; the top entry -> NO_SUITABLE_INCREMENT", async () => {
    const { userId: userA, athleteProfileId: athleteA } = await createAthlete();
    const planA = await seedProgram(athleteA, { loadAmountMilli: 21000, exerciseRef: "squat" });
    await setupEnumeratedListCapability(athleteA, planA.exerciseRef, [20000, 22000, 24000]); // 21000 absent
    const decisionA = await createDecision({ userId: userA, exerciseRef: planA.exerciseRef, sourcePrescriptionExerciseId: planA.exerciseId });
    const appA = await ensureAndGetId(userA, decisionA);
    const outcomeA = await applyProgression(db, { userId: userA }, { applicationId: appA, commandId: createEntityId() });
    expect(outcomeA.status).toBe("NOT_APPLIED");
    if (outcomeA.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcomeA.reason).toBe("CURRENT_LOAD_UNSUPPORTED");

    const { userId: userB, athleteProfileId: athleteB } = await createAthlete();
    const planB = await seedProgram(athleteB, { loadAmountMilli: 24000, exerciseRef: "squat" });
    await setupEnumeratedListCapability(athleteB, planB.exerciseRef, [20000, 22000, 24000]); // 24000 is the top entry
    const decisionB = await createDecision({ userId: userB, exerciseRef: planB.exerciseRef, sourcePrescriptionExerciseId: planB.exerciseId });
    const appB = await ensureAndGetId(userB, decisionB);
    const outcomeB = await applyProgression(db, { userId: userB }, { applicationId: appB, commandId: createEntityId() });
    expect(outcomeB.status).toBe("NOT_APPLIED");
    if (outcomeB.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcomeB.reason).toBe("NO_SUITABLE_INCREMENT");
  });

  // Loading Capability Foundation fail-closed composition (task §37)
  it("PROG-APP-C-INVALID-CAPABILITY: a malformed raw-persisted ENUMERATED_LIST fails closed as LOADING_CAPABILITY_INVALID, never crashes, never applies", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 24000 });
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const malformedId = createEntityId();
    await db.insert(loadingCapabilities).values({
      id: malformedId,
      gymProfileId: gym.id,
      unit: "KG",
      basis: "TOTAL",
      kind: "ENUMERATED_LIST",
      enumeratedLoadsMilli: [20000, 24000, 22000], // unsorted — bypasses the domain write boundary
    });
    await bindExerciseToCapability(db, gym.id, plan.exerciseRef, malformedId);

    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const outcome = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(outcome.status).toBe("NOT_APPLIED");
    if (outcome.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcome.reason).toBe("LOADING_CAPABILITY_INVALID");
    expect(outcome.application.status).toBe("PENDING_REVIEW");

    const [row] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, malformedId));
    expect(row?.enumeratedLoadsMilli).toEqual([20000, 24000, 22000]); // untouched, no repair
  });

  // 17, 18, 19
  it("PROG-APP-C-017: the CURRENT overlay unique index permits only one APPLIED row per stream — successful replacement supersedes the old head, whose audit remains intact", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);

    const decisionA = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const appAId = await ensureAndGetId(userId, decisionA);
    const outcomeA = await applyProgression(db, { userId }, { applicationId: appAId, commandId: createEntityId() });
    expect(outcomeA.status).toBe("APPLIED");
    if (outcomeA.status !== "APPLIED") throw new Error("expected APPLIED");
    const originalAuditA = { ...outcomeA.application };

    // A second cycle, source-prescribed at the NOW-effective 102.5 baseline.
    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const decisionB = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const appBId = await ensureAndGetId(userId, decisionB);
    const outcomeB = await applyProgression(db, { userId }, { applicationId: appBId, commandId: createEntityId() });
    expect(outcomeB.status).toBe("APPLIED");
    if (outcomeB.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(outcomeB.application.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    expect(outcomeB.application.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 105000, unit: "KG", basis: "TOTAL" });

    const [rowA] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appAId));
    expect(rowA?.status).toBe("SUPERSEDED");
    expect(rowA?.supersededByApplicationId).toBe(appBId);
    // Historical audit remains exactly as it was applied (task §17/§19):
    expect(rowA?.appliedLoad).toEqual(originalAuditA.appliedLoad);
    expect(rowA?.appliedAt?.getTime()).toBe(originalAuditA.appliedAt?.getTime());
    expect(rowA?.loadingCapabilitySnapshot).toEqual(originalAuditA.loadingCapabilitySnapshot);

    // Exactly one row is the current head:
    const currentHeads = await db.select().from(progressionApplications).where(eq(progressionApplications.status, "APPLIED"));
    const streamHeads = currentHeads.filter((r) => r.userId === userId && r.programVersionId === plan.versionId);
    expect(streamHeads).toHaveLength(1);
    expect(streamHeads[0]?.id).toBe(appBId);
  });

  // 22, 23, 24 — task §8's exact worked example + task §9's corrected-evidence case
  it("PROG-APP-C-HISTORICAL: Cycle 1/2/3 historical resolution is correct, and a corrected same-cycle decision never double-progresses", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 }); // cycle 1
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);

    // Application A, sourced at cycle 1: authored 100 -> applied 102.5.
    const decisionA = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const appAId = await ensureAndGetId(userId, decisionA);
    const outcomeA = await applyProgression(db, { userId }, { applicationId: appAId, commandId: createEntityId() });
    if (outcomeA.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(outcomeA.application.appliedLoad?.amountMilli).toBe(102500);

    // Cycle 2 occurrence of the same slot — its own ensure() must see 102.5, not 100 (task §8).
    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const decisionB1 = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const appB1Id = await ensureAndGetId(userId, decisionB1);
    const [appB1Row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appB1Id));
    expect(appB1Row?.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    // Corrected evidence (task §9): D1 (=decisionB1) is superseded by D2,
    // sourced from the SAME cycle-2 occurrence — reusing decisionB1's own
    // real source workout/performed-exercise ids (both NOT NULL real FKs).
    const [decisionB1Row] = await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, decisionB1));
    const decisionB2 = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionB2,
      userId,
      exerciseRef: plan.exerciseRef,
      sourceWorkoutSessionId: decisionB1Row!.sourceWorkoutSessionId,
      sourcePerformedExerciseId: decisionB1Row!.sourcePerformedExerciseId,
      sourcePrescriptionExerciseId: week2.exerciseId,
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
    await db.update(progressionDecisions).set({ supersededByDecisionId: decisionB2 }).where(eq(progressionDecisions.id, decisionB1));

    const appB2Id = await ensureAndGetId(userId, decisionB2);
    const [appB2Row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appB2Id));
    // MUST still be 102.5 — never 105 (never double-progressed from B1's own would-be application).
    expect(appB2Row?.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    const outcomeB2 = await applyProgression(db, { userId }, { applicationId: appB2Id, commandId: createEntityId() });
    if (outcomeB2.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(outcomeB2.application.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 105000, unit: "KG", basis: "TOTAL" });

    // Cycle 3 (task §8's worked example): must resolve 105, built from B2's historical application, not authored 100.
    const week3 = await addCycleWorkoutExercise(plan.blockId, 3, 1, 1, plan.exerciseRef, 100000);
    const decisionC = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week3.exerciseId });
    const appCId = await ensureAndGetId(userId, decisionC);
    const [appCRow] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appCId));
    expect(appCRow?.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 105000, unit: "KG", basis: "TOTAL" });
  });

  // 20, 26 — a later NO_CHANGE (represented by never creating an application) leaves the applied overlay effective
  it("PROG-APP-C-020: after Apply, a later cycle's resolution reflects the applied load — no accidental revert to authored", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);
    const applied = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    if (applied.status !== "APPLIED") throw new Error("expected APPLIED");

    // A later cycle's NO_CHANGE decision creates no application at all (task §43) —
    // simulate purely by NOT creating one, and confirm a subsequent occurrence
    // still resolves to the applied 102.5, never reverting to authored 100.
    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const laterDecision = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const laterAppId = await ensureAndGetId(userId, laterDecision);
    const [laterAppRow] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, laterAppId));
    expect(laterAppRow?.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
  });

  // 27
  it("PROG-APP-C-027: a new ProgramVersion does not inherit an old version's applied overlay", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);
    const applied = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    if (applied.status !== "APPLIED") throw new Error("expected APPLIED");

    // A brand-new ProgramVersion for the same program — its own identical-looking slot is a DIFFERENT stream key.
    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, plan.versionId));
    const [program] = await db.select().from(programs).where(eq(programs.athleteProfileId, athleteProfileId));
    const [newVersion] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 2, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [newBlock] = await db
      .insert(trainingBlocks)
      .values({ id: createEntityId(), programVersionId: newVersion!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] })
      .returning();
    const newSlot = await addCycleWorkoutExercise(newBlock!.id, 1, 1, 1, plan.exerciseRef, 100000);
    const newDecision = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: newSlot.exerciseId });
    const newAppId = await ensureAndGetId(userId, newDecision);
    const [newAppRow] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, newAppId));
    expect(newAppRow?.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" }); // authored, not 102.5
  });

  // 34, 35
  it("PROG-APP-C-034: repeated Apply with the SAME commandId is idempotent; the SAME commandId reused for a different application is COMMAND_CONFLICT", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionA = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const appAId = await ensureAndGetId(userId, decisionA);

    const commandId = createEntityId();
    const first = await applyProgression(db, { userId }, { applicationId: appAId, commandId });
    const second = await applyProgression(db, { userId }, { applicationId: appAId, commandId });
    expect(first).toEqual(second);
    const receipts = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.commandId, commandId));
    expect(receipts).toHaveLength(1);

    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const decisionB = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const appBId = await ensureAndGetId(userId, decisionB);
    const conflicting = await applyProgression(db, { userId }, { applicationId: appBId, commandId });
    expect(conflicting.status).toBe("COMMAND_CONFLICT");
  });

  // 36
  it("PROG-APP-C-036: two concurrent Apply calls on the SAME application converge to exactly one success", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyProgression(createDatabaseClient(DATABASE_URL), { userId }, { applicationId, commandId: createEntityId() })),
    );
    expect(results.every((r) => r.status === "APPLIED")).toBe(true); // converge — every distinct commandId agrees the target state holds

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("APPLIED");
  });

  // 38
  it("PROG-APP-C-038: Apply vs KEEP_ORIGINAL race on the same application resolves to exactly one terminal state, never both", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const [applyResult, keepResult] = await Promise.all([
      applyProgression(createDatabaseClient(DATABASE_URL), { userId }, { applicationId, commandId: createEntityId() }),
      keepOriginal(createDatabaseClient(DATABASE_URL), { userId }, { applicationId, commandId: createEntityId() }),
    ]);

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(["APPLIED", "KEPT_ORIGINAL"]).toContain(row?.status);

    // Whichever won, the OTHER command's own outcome must agree with the final state — never a phantom success.
    if (row?.status === "APPLIED") {
      expect(applyResult.status).toBe("APPLIED");
    } else {
      expect(keepResult.status).toBe("KEPT_ORIGINAL");
    }
  });

  // 30, 42 — the exact required proof, achieved via a real Apply-vs-KeepOriginal
  // race (not artificial fault injection — this codebase's own convention
  // never adds test-only branches to production code) against a stream that
  // ALREADY has a current APPLIED head to supersede. If KEEP_ORIGINAL wins B's
  // row, Apply's own transaction (which had already superseded A in-memory)
  // must roll back in its entirety when its final PENDING_REVIEW -> APPLIED
  // write finds 0 matching rows (`ApplyLostToConcurrentDecision` in
  // `progression-application-apply.ts`) — proving the supersession never
  // survives an Apply that itself does not complete.
  it("PROG-APP-C-030: a losing Apply's supersession of the old head never survives — the old head remains APPLIED if the new one does not actually become APPLIED", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);

    const decisionA = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const appAId = await ensureAndGetId(userId, decisionA);
    const outcomeA = await applyProgression(db, { userId }, { applicationId: appAId, commandId: createEntityId() });
    if (outcomeA.status !== "APPLIED") throw new Error("expected APPLIED");
    const originalAuditA = { ...outcomeA.application };

    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const decisionB = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const appBId = await ensureAndGetId(userId, decisionB);

    const [applyBResult, keepBResult] = await Promise.all([
      applyProgression(createDatabaseClient(DATABASE_URL), { userId }, { applicationId: appBId, commandId: createEntityId() }),
      keepOriginal(createDatabaseClient(DATABASE_URL), { userId }, { applicationId: appBId, commandId: createEntityId() }),
    ]);

    const [rowA] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appAId));
    const [rowB] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, appBId));

    if (rowB?.status === "KEPT_ORIGINAL") {
      // Apply for B lost the race entirely — A's supersession must never have survived.
      expect(keepBResult.status).toBe("KEPT_ORIGINAL");
      expect(rowA?.status).toBe("APPLIED");
      expect(rowA?.supersededByApplicationId).toBeNull();
      expect(rowA?.appliedLoad).toEqual(originalAuditA.appliedLoad);
      expect(rowA?.appliedAt?.getTime()).toBe(originalAuditA.appliedAt?.getTime());
    } else {
      // Apply for B won — A is correctly superseded, B is the new head.
      expect(applyBResult.status).toBe("APPLIED");
      expect(rowB?.status).toBe("APPLIED");
      expect(rowA?.status).toBe("SUPERSEDED");
      expect(rowA?.supersededByApplicationId).toBe(appBId);
    }

    // Exactly one current head for the stream, never zero, never two:
    const heads = await db
      .select()
      .from(progressionApplications)
      .where(eq(progressionApplications.status, "APPLIED"));
    const streamHeads = heads.filter((r) => r.userId === userId && r.programVersionId === plan.versionId);
    expect(streamHeads).toHaveLength(1);
  });

  // 39
  it("PROG-APP-C-039: a concurrent capability revision update never produces a mismatched audit — the applied snapshot always matches the revision actually used", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const { loadingCapabilityId } = await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    const [applyOutcome] = await Promise.all([
      applyProgression(createDatabaseClient(DATABASE_URL), { userId }, { applicationId, commandId: createEntityId() }),
      updateLoadingCapabilityPayload(createDatabaseClient(DATABASE_URL), loadingCapabilityId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 5000 }),
    ]);

    if (applyOutcome.status !== "APPLIED") throw new Error("expected APPLIED");
    const [capabilityRow] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, loadingCapabilityId));

    // Whichever revision Apply's own audit recorded, it must be internally
    // self-consistent: the snapshot's incrementAmountMilli and the
    // appliedLoad's delta from the authored 100000 baseline must agree.
    const snapshot = applyOutcome.application.loadingCapabilitySnapshot;
    expect(snapshot?.kind).toBe("FIXED_INCREMENT");
    if (snapshot?.kind === "FIXED_INCREMENT") {
      expect(applyOutcome.application.appliedLoad?.amountMilli).toBe(100000 + snapshot.incrementAmountMilli);
    }
    // The live capability row (post-update) may now be a different revision
    // than the audit recorded — that is expected and is exactly the point:
    expect(capabilityRow?.revision).toBeGreaterThanOrEqual(applyOutcome.application.loadingCapabilityRevision ?? 0);
    // The audit itself never changes after the fact, regardless of the live row:
    expect(applyOutcome.application.loadingCapabilityRevision).not.toBeNull();
  });

  // Binding-concurrency gate — the exact exercise->LoadingCapability BINDING
  // must also serialize against numeric Apply, not merely the resolved
  // capability row it happens to point at. `resolveBoundCapabilityForUpdate`'s
  // single joined `SELECT ... FOR UPDATE` locks BOTH the binding row and its
  // capability row in one statement (Postgres's own standard behavior for
  // `FOR UPDATE` over a join — locks rows from every joined table, verified
  // directly against real Postgres before writing this test: a concurrent
  // raw UPDATE of the binding row blocked for the full lock duration). This
  // test proves the two valid outcomes a real rebind race can produce.
  it("PROG-APP-C-BINDING-RACE: a concurrent BENCH rebind (capability A -> B) never lets Apply commit a value from the wrong capability, and never silently reapplies a stale confirmed proposal", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const createdA = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (createdA.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, plan.exerciseRef, createdA.loadingCapabilityId);
    const createdB = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 5000 });
    if (createdB.status !== "CREATED") throw new Error("expected CREATED");

    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    // The athlete's own remembered proposal, captured BEFORE the race —
    // exactly what a real confirmed-Apply caller would have (task §32/§8).
    const proposal = await resolveApplicationProposal(db, { userId }, applicationId);
    if (proposal.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(proposal.loadingCapabilityId).toBe(createdA.loadingCapabilityId);
    expect(proposal.resolverProposedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });

    const [applyOutcome] = await Promise.all([
      applyProgression(createDatabaseClient(DATABASE_URL), { userId }, {
        applicationId,
        commandId: createEntityId(),
        expectedProposal: {
          expectedLoadingCapabilityId: proposal.loadingCapabilityId,
          expectedResolverProposedLoad: proposal.resolverProposedLoad,
        },
      }),
      // No canonical binding-rewrite service exists yet (task §6) — a
      // direct raw-SQL rebind is sufficient to prove the real database
      // locking semantics a future canonical writer will encounter.
      createDatabaseClient(DATABASE_URL)
        .update(exerciseLoadingCapabilityBindings)
        .set({ loadingCapabilityId: createdB.loadingCapabilityId })
        .where(and(eq(exerciseLoadingCapabilityBindings.gymProfileId, gym.id), eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef))),
    ]);

    const [finalBinding] = await db
      .select()
      .from(exerciseLoadingCapabilityBindings)
      .where(and(eq(exerciseLoadingCapabilityBindings.gymProfileId, gym.id), eq(exerciseLoadingCapabilityBindings.exerciseRef, plan.exerciseRef)));
    expect(finalBinding?.loadingCapabilityId).toBe(createdB.loadingCapabilityId); // the rebind always eventually lands, whichever order won

    if (applyOutcome.status === "APPLIED") {
      // Outcome A: Apply won the binding lock first — it used capability A,
      // exactly as the caller's confirmed proposal said, and the audit says so.
      expect(applyOutcome.application.loadingCapabilityId).toBe(createdA.loadingCapabilityId);
      expect(applyOutcome.application.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
      const snapshot = applyOutcome.application.loadingCapabilitySnapshot;
      expect(snapshot?.kind === "FIXED_INCREMENT" ? snapshot.incrementAmountMilli : null).toBe(2500);
    } else {
      // Outcome B: the rebind committed first — Apply re-derived the
      // proposal inside its own locked transaction, saw capability B (+5000,
      // i.e. 105000), which disagrees with the caller's confirmed 102500 ->
      // PROPOSAL_REFRESH_REQUIRED, never a silent 105000 commit.
      expect(applyOutcome.status).toBe("NOT_APPLIED");
      if (applyOutcome.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
      expect(applyOutcome.reason).toBe("PROPOSAL_REFRESH_REQUIRED");
      expect(applyOutcome.application.status).toBe("PENDING_REVIEW");
      expect(applyOutcome.application.appliedAt).toBeNull();
    }

    // No invalid outcome is possible either way: re-select the final
    // application row directly and verify the SAME coherent state.
    const [finalRow] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    if (finalRow?.status === "APPLIED") {
      expect(finalRow.loadingCapabilityId).toBe(createdA.loadingCapabilityId);
      expect(finalRow.appliedLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" });
    } else {
      expect(finalRow?.status).toBe("PENDING_REVIEW");
      expect(finalRow?.appliedAt).toBeNull();
      expect(finalRow?.loadingCapabilityId).toBeNull();
    }
  });

  // 40, 30
  it("PROG-APP-C-040: Plan becoming stale before Apply's lock is acquired rejects the Apply — no supersession, no audit written", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);

    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, plan.versionId));

    const outcome = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(outcome.status).toBe("NOT_APPLIED");
    if (outcome.status !== "NOT_APPLIED") throw new Error("expected NOT_APPLIED");
    expect(outcome.reason).toBe("STALE");
    expect(outcome.application.appliedAt).toBeNull();

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("STALE");
    expect(row?.appliedAt).toBeNull();
  });

  // 43, 44
  it("PROG-APP-C-043: BOLA — actor B cannot resolve or apply actor A's application", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const plan = await seedProgram(athleteA.athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteA.athleteProfileId, plan.exerciseRef, 2500);
    const decisionId = await createDecision({ userId: athleteA.userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(athleteA.userId, decisionId);

    const proposal = await resolveApplicationProposal(db, { userId: athleteB.userId }, applicationId);
    expect(proposal.status).toBe("NOT_FOUND");

    const applyOutcome = await applyProgression(db, { userId: athleteB.userId }, { applicationId, commandId: createEntityId() });
    expect(applyOutcome.status).toBe("NOT_FOUND");

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId));
    expect(row?.status).toBe("PENDING_REVIEW"); // untouched by B's attempt
  });

  // 32/33 — Workout Start's hard snapshot boundary (task §46)
  it("PROG-APP-C-WORKOUT-START: a workout session's stored prescription snapshot is never touched by a later Apply", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    await setupFixedIncrementCapability(athleteProfileId, plan.exerciseRef, 2500);

    // A session "started" against the CURRENT (authored) baseline, before any Apply exists.
    const startedSessionId = createEntityId();
    const originalSnapshot = { schemaVersion: 1, exercises: [{ exerciseRef: plan.exerciseRef, targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" } }] };
    await db.insert(workoutSessions).values({ id: startedSessionId, userId, prescriptionSnapshot: originalSnapshot, startedAt: new Date(), status: "ACTIVE" });

    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const applicationId = await ensureAndGetId(userId, decisionId);
    const applied = await applyProgression(db, { userId }, { applicationId, commandId: createEntityId() });
    expect(applied.status).toBe("APPLIED"); // future effective load is now 102.5

    const [sessionRow] = await db.select().from(workoutSessions).where(eq(workoutSessions.id, startedSessionId));
    expect(sessionRow?.prescriptionSnapshot).toEqual(originalSnapshot); // byte-identical, forever
  });
});
