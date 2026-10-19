import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  athleteProfiles,
  availableTimeApplications,
  createDatabaseClient,
  equipmentAdaptationApplications,
  exerciseLoadingCapabilityBindings,
  gymProfiles,
  loadingCapabilities,
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  performedExercises,
  performedSets,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
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
import { EXERCISE_EQUIPMENT_CATALOG_VERSION_V1, createEntityId, selectAvailableTimePrescription, type PrescribedExerciseV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { availableTimeApplicationFromPreview, type WorkoutPreviewV1 } from "@vostivo/contracts";
import {
  applySystemProgression,
  bindExerciseToCapability,
  createLoadingCapability,
  ensureApplicationForDecision,
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";
import { fixedClock } from "../common/clock.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { AvailableTimePreviewService } from "../plan/available-time-preview.service.js";
import { EquipmentAdaptationPreviewService } from "../plan/equipment-adaptation-preview.service.js";
import { EquipmentAdaptationApplyService } from "../plan/equipment-adaptation-apply.service.js";
import { decodeProgressCursor, encodeProgressCursor } from "./progress-cursor.js";
import { ProgressReadService } from "./progress-read.service.js";

/**
 * Progress & Feedback V1 — Slice A — real Postgres. Service-level (this
 * codebase's convention, see `plan.integration.test.ts`). The fixture is
 * Journey A of the Full Athlete Journey E2E Audit: Bench Press authored
 * 60 kg × 3, performed 60 kg × 12/12/12, GUIDED SYSTEM apply → 62.5 kg on
 * the next Upper A — plus a SECONDARY session of the same occurrence, an
 * equipment substitute + Available-Time session, a pending (unapplied)
 * recommendation, and a second athlete for BOLA.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
// Wednesday 2026-10-14, 12:00 in Europe/Prague.
const NOW = new Date("2026-10-14T10:00:00.000Z");
const KG = (kg: number) => ({ kind: "EXTERNAL_WEIGHT" as const, amountMilli: kg * 1000, unit: "KG" as const, basis: "TOTAL" as const });

interface PlannedExerciseFixture {
  readonly id: string;
  readonly exerciseRef: string;
  readonly displayName: string;
  readonly order: number;
  readonly sets: readonly { readonly id: string; readonly order: number; readonly setType: "WORKING" | "WARM_UP"; readonly kg: number }[];
}

interface PlannedWorkoutFixture {
  readonly id: string;
  readonly name: string;
  readonly exercises: readonly PlannedExerciseFixture[];
}

// Each test seeds a full journey (~40 statements); the 5 s default is too tight on a cold first run.
describe("ProgressReadService (real Postgres)", { timeout: 20_000 }, () => {
  let db: Database;
  let service: ProgressReadService;
  let planRead: PlanReadService;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
    const clock = fixedClock(NOW);
    planRead = new PlanReadService(db, clock);
    service = new ProgressReadService(db, clock, planRead);
  });

  async function createAthlete(trainingTimeZone: string | null = "Europe/Prague"): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC", trainingTimeZone });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  async function insertWorkout(cycleId: string, name: string, order: number, date: string, exercises: readonly { exerciseRef: string; displayName: string; sets: readonly { setType: "WORKING" | "WARM_UP"; kg: number }[] }[]): Promise<PlannedWorkoutFixture> {
    const workoutId = createEntityId();
    await db.insert(plannedWorkouts).values({ id: workoutId, trainingCycleId: cycleId, name, orderIndex: order, scheduledDate: date, status: "PLANNED" });
    const fixtures: PlannedExerciseFixture[] = [];
    for (const [exerciseIndex, exercise] of exercises.entries()) {
      const exerciseId = createEntityId();
      await db.insert(plannedExercises).values({ id: exerciseId, plannedWorkoutId: workoutId, exerciseRef: exercise.exerciseRef, displayName: exercise.displayName, orderIndex: exerciseIndex + 1 });
      const sets = exercise.sets.map((set, setIndex) => ({ id: createEntityId(), order: setIndex + 1, setType: set.setType, kg: set.kg }));
      for (const set of sets) {
        await db.insert(plannedSets).values({ id: set.id, plannedExerciseId: exerciseId, orderIndex: set.order, targetRepsMin: 8, targetRepsMax: 12, setType: set.setType, loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: set.kg * 1000, loadUnit: "KG", loadBasis: "TOTAL" });
      }
      fixtures.push({ id: exerciseId, exerciseRef: exercise.exerciseRef, displayName: exercise.displayName, order: exerciseIndex + 1, sets });
    }
    return { id: workoutId, name, exercises: fixtures };
  }

  const UPPER_A = [
    { exerciseRef: "bench-press", displayName: "Bench Press", sets: [{ setType: "WARM_UP" as const, kg: 20 }, { setType: "WORKING" as const, kg: 60 }, { setType: "WORKING" as const, kg: 60 }, { setType: "WORKING" as const, kg: 60 }] },
    { exerciseRef: "overhead-press", displayName: "Overhead Press", sets: [{ setType: "WORKING" as const, kg: 30 }, { setType: "WORKING" as const, kg: 30 }] },
  ];

  /** Block of 2 weekly cycles: Upper A Mon, Lower A Wed (= today), Upper B Fri. */
  async function seedPlan(athleteProfileId: string) {
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Strength Base", goal: "Strength", orderIndex: 1, cycleCount: 2, focusAreas: [] }).returning();
    const [cycle1] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: "2026-10-12", endDate: "2026-10-18" }).returning();
    const [cycle2] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 2, startDate: "2026-10-19", endDate: "2026-10-25" }).returning();
    const lowerA = [{ exerciseRef: "bench-press", displayName: "Bench Press", sets: [{ setType: "WORKING" as const, kg: 50 }] }];
    return {
      upperA1: await insertWorkout(cycle1!.id, "Upper A", 1, "2026-10-12", UPPER_A),
      lowerA1: await insertWorkout(cycle1!.id, "Lower A", 2, "2026-10-14", lowerA),
      upperB1: await insertWorkout(cycle1!.id, "Upper B", 3, "2026-10-16", [{ exerciseRef: "lat-pulldown", displayName: "Lat Pulldown", sets: [{ setType: "WORKING", kg: 50 }] }]),
      upperA2: await insertWorkout(cycle2!.id, "Upper A", 1, "2026-10-19", UPPER_A),
      lowerA2: await insertWorkout(cycle2!.id, "Lower A", 2, "2026-10-21", lowerA),
      programVersionId: version!.id,
    };
  }

  function snapshotOf(workout: PlannedWorkoutFixture, substitute?: { exerciseOrder: number; exerciseRef: string; displayName: string }): WorkoutPrescriptionV1 {
    return {
      schemaVersion: 1,
      prescriptionId: workout.id,
      name: workout.name,
      exercises: workout.exercises.map((exercise): PrescribedExerciseV1 => {
        const isSubstitute = substitute?.exerciseOrder === exercise.order;
        return {
          prescriptionExerciseId: exercise.id,
          exerciseRef: isSubstitute ? substitute.exerciseRef : exercise.exerciseRef,
          displayName: isSubstitute ? substitute.displayName : exercise.displayName,
          order: exercise.order,
          sets: exercise.sets.map((set) => ({ prescriptionSetId: set.id, order: set.order, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: isSubstitute ? null : KG(set.kg), restSeconds: 90, setType: set.setType })),
          ...(isSubstitute
            ? {
                substitution: {
                  kind: "TEMPORARY_EQUIPMENT" as const,
                  reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE" as const,
                  authoredExerciseRef: exercise.exerciseRef,
                  authoredDisplayName: exercise.displayName,
                  equipmentApplicationId: createEntityId(),
                  policyVersion: "equipment-adaptation/v1" as const,
                  catalogVersion: "exercise-equipment-catalog/v1",
                },
              }
            : {}),
        };
      }),
    };
  }

  /** A COMPLETED session; `claim` decides whether it is the occurrence's CANONICAL session. Returns performed exercise ids by planned exercise order. */
  async function completeSession(
    userId: string,
    workout: PlannedWorkoutFixture,
    options: {
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly claim: boolean;
      readonly performed: readonly { readonly exerciseOrder: number; readonly exerciseRef?: string; readonly displayName?: string; readonly sets: readonly { readonly setType: "WORKING" | "WARM_UP"; readonly reps: number; readonly kg: number; readonly reopened?: boolean }[] }[];
      readonly substitute?: { exerciseOrder: number; exerciseRef: string; displayName: string };
    },
  ): Promise<{ readonly sessionId: string; readonly performedExerciseIds: ReadonlyMap<number, string> }> {
    const sessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: sessionId, userId, prescriptionSnapshot: snapshotOf(workout, options.substitute), startedAt: options.startedAt, status: "COMPLETED", completedAt: options.completedAt, finishSeq: 0 });
    if (options.claim) await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId, plannedWorkoutId: workout.id, canonicalWorkoutSessionId: sessionId });
    const performedExerciseIds = new Map<number, string>();
    for (const performed of options.performed) {
      const planned = workout.exercises.find((e) => e.order === performed.exerciseOrder)!;
      const performedExerciseId = createEntityId();
      performedExerciseIds.set(performed.exerciseOrder, performedExerciseId);
      await db.insert(performedExercises).values({ id: performedExerciseId, workoutSessionId: sessionId, prescriptionExerciseId: planned.id, exerciseRef: performed.exerciseRef ?? planned.exerciseRef, displayName: performed.displayName ?? planned.displayName, orderIndex: planned.order });
      for (const [index, set] of performed.sets.entries()) {
        await db.insert(performedSets).values({
          id: createEntityId(),
          performedExerciseId,
          prescriptionSetId: planned.sets[index]?.id ?? null,
          orderIndex: index + 1,
          actualReps: set.reps,
          loadKind: "EXTERNAL_WEIGHT",
          loadAmountMilli: set.kg * 1000,
          loadUnit: "KG",
          loadBasis: "TOTAL",
          setType: set.setType,
          completionState: set.reopened === true ? "REOPENED" : "COMPLETED",
          completedAt: set.reopened === true ? null : options.completedAt,
          revision: 1,
        });
      }
    }
    return { sessionId, performedExerciseIds };
  }

  async function createDecision(userId: string, sessionId: string, performedExerciseId: string, exerciseRef: string, plannedExerciseId: string): Promise<string> {
    const decisionId = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionId,
      userId,
      exerciseRef,
      sourceWorkoutSessionId: sessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId: plannedExerciseId,
      engine: "progression",
      policy: "v1",
      decisionType: "INCREASE_LOAD",
      reasonCode: "TOP_OF_RANGE_ACHIEVED",
      evidenceStrength: "SINGLE_EXPOSURE",
      progressionStalled: false,
      recommendedChange: { direction: "INCREASE_LOAD" },
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });
    return decisionId;
  }

  /** The full Journey A fixture for one athlete. */
  async function seedJourney() {
    const athlete = await createAthlete();
    const plan = await seedPlan(athlete.athleteProfileId);
    // Upper A (Mon): bench 60 × 12/12/12 + warm-up; OHP 1 of 2 sets, a 2nd reopened -> PARTIAL.
    const upperA = await completeSession(athlete.userId, plan.upperA1, {
      startedAt: new Date("2026-10-12T16:00:00.000Z"),
      completedAt: new Date("2026-10-12T17:05:00.000Z"),
      claim: true,
      performed: [
        { exerciseOrder: 1, sets: [{ setType: "WARM_UP", reps: 10, kg: 20 }, { setType: "WORKING", reps: 12, kg: 60 }, { setType: "WORKING", reps: 12, kg: 60 }, { setType: "WORKING", reps: 12, kg: 60 }] },
        { exerciseOrder: 2, sets: [{ setType: "WORKING", reps: 10, kg: 30 }, { setType: "WORKING", reps: 6, kg: 30, reopened: true }] },
      ],
    });
    // The same occurrence started on a second device: SECONDARY, never progress.
    const secondary = await completeSession(athlete.userId, plan.upperA1, {
      startedAt: new Date("2026-10-12T16:01:00.000Z"),
      completedAt: new Date("2026-10-12T18:00:00.000Z"),
      claim: false,
      performed: [{ exerciseOrder: 1, sets: [{ setType: "WORKING", reps: 5, kg: 100 }] }],
    });
    // Lower A (today): bench replaced by dumbbell bench (equipment), started Available-Time adjusted.
    const lowerA = await completeSession(athlete.userId, plan.lowerA1, {
      startedAt: new Date("2026-10-14T06:00:00.000Z"),
      completedAt: new Date("2026-10-14T06:40:00.000Z"),
      claim: true,
      substitute: { exerciseOrder: 1, exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press" },
      performed: [{ exerciseOrder: 1, exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", sets: [{ setType: "WORKING", reps: 10, kg: 22 }] }],
    });
    await db.insert(availableTimeApplications).values({
      id: createEntityId(),
      workoutSessionId: lowerA.sessionId,
      userId: athlete.userId,
      plannedWorkoutId: plan.lowerA1.id,
      sourceProgramVersionId: plan.programVersionId,
      scope: "TODAY_ONLY",
      policyVersion: "available-time/v1",
      availableMinutes: 30,
      previewFingerprint: "f".repeat(64),
      originalEstimatedSeconds: 2400,
      adjustedEstimatedSeconds: 1500,
      structuralDiff: [],
      verificationStatus: "VERIFIED",
    });

    // Bench INCREASE_LOAD -> GUIDED SYSTEM apply (real Slice C/D core) -> 62.5 kg.
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athlete.athleteProfileId);
    const capability = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capability.status !== "CREATED") throw new Error("expected CREATED capability");
    await bindExerciseToCapability(db, gym.id, "bench-press", capability.loadingCapabilityId);
    const benchDecision = await createDecision(athlete.userId, upperA.sessionId, upperA.performedExerciseIds.get(1)!, "bench-press", plan.upperA1.exercises[0]!.id);
    const benchApplication = await ensureApplicationForDecision(db, { userId: athlete.userId }, benchDecision);
    if (benchApplication.status !== "CREATED") throw new Error("expected CREATED application");
    const applied = await applySystemProgression(db, { applicationId: benchApplication.application.id, systemCommandId: createEntityId() });
    if (applied.status !== "APPLIED") throw new Error(`expected APPLIED, got ${applied.status}`);

    // OHP INCREASE_LOAD left PENDING_REVIEW (never applied) — never an improvement.
    const ohpDecision = await createDecision(athlete.userId, upperA.sessionId, upperA.performedExerciseIds.get(2)!, "overhead-press", plan.upperA1.exercises[1]!.id);
    const ohpApplication = await ensureApplicationForDecision(db, { userId: athlete.userId }, ohpDecision);
    if (ohpApplication.status !== "CREATED") throw new Error("expected CREATED application");

    return { athlete, plan, upperA, secondary, lowerA, benchApplicationId: benchApplication.application.id };
  }

  afterEach(async () => {
    if (userIds.length === 0) return;
    const applicationRows = await db.select({ id: progressionApplications.id }).from(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    const applicationIds = applicationRows.map((r) => r.id);
    if (applicationIds.length > 0) await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.applicationId, applicationIds));
    await db.delete(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, userIds));
    await db.delete(availableTimeApplications).where(inArray(availableTimeApplications.userId, userIds));
    await db.delete(equipmentAdaptationApplications).where(inArray(equipmentAdaptationApplications.userId, userIds));
    const overlayIds = (await db.select({ id: missedWorkoutScheduleApplications.id }).from(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.appliedByUserId, userIds))).map((r) => r.id);
    if (overlayIds.length > 0) {
      await db.delete(missedWorkoutScheduleAssignments).where(inArray(missedWorkoutScheduleAssignments.applicationId, overlayIds));
      await db.delete(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.id, overlayIds));
    }
    await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, userIds));

    const sessionIds = (await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds))).map((r) => r.id);
    if (sessionIds.length > 0) {
      const exerciseIds = (await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds))).map((r) => r.id);
      if (exerciseIds.length > 0) {
        await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
        await db.delete(performedExercises).where(inArray(performedExercises.id, exerciseIds));
      }
      await db.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
    }

    const athleteProfileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, userIds))).map((r) => r.id);
    if (athleteProfileIds.length > 0) {
      const gymProfileIds = (await db.select({ id: gymProfiles.id }).from(gymProfiles).where(inArray(gymProfiles.athleteProfileId, athleteProfileIds))).map((r) => r.id);
      if (gymProfileIds.length > 0) {
        await db.delete(exerciseLoadingCapabilityBindings).where(inArray(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileIds));
        await db.delete(loadingCapabilities).where(inArray(loadingCapabilities.gymProfileId, gymProfileIds));
        await db.delete(gymProfiles).where(inArray(gymProfiles.id, gymProfileIds));
      }
      const programIds = (await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, athleteProfileIds))).map((r) => r.id);
      if (programIds.length > 0) {
        const versionIds = (await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds))).map((r) => r.id);
        const blockIds = (await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds))).map((r) => r.id);
        const cycleIds = (await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds))).map((r) => r.id);
        const workoutIds = (await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds))).map((r) => r.id);
        const exerciseIds = (await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds))).map((r) => r.id);
        if (exerciseIds.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
        if (workoutIds.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
        await db.delete(programs).where(inArray(programs.id, programIds));
      }
      await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, athleteProfileIds));
    }
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  it("PROGRESS-A-001: overview — current-cycle snapshot, the applied improvement with its evidence and next exposure, canonical recent workouts", async () => {
    const { athlete, plan, upperA, lowerA, benchApplicationId } = await seedJourney();

    const overview = await service.getOverview(athlete);

    expect(overview.schemaVersion).toBe(1);
    expect(overview.athleteLocalDate).toBe("2026-10-14");
    // Upper A (Mon) + Lower A (today) are due and done; Upper B (Fri) is not due yet.
    expect(overview.snapshot).toEqual({ block: { name: "Strength Base", cycleOrder: 1, cycleCount: 2 }, thisWeek: { completed: 2, due: 2 } });

    // Only the APPLIED bench change — the pending OHP recommendation is not an improvement.
    expect(overview.improving).toHaveLength(1);
    const [bench] = overview.improving;
    expect(bench).toMatchObject({
      applicationId: benchApplicationId,
      exerciseRef: "bench-press",
      exerciseDisplayName: "Bench Press",
      fromLoad: KG(60),
      toLoad: KG(62.5),
      actor: "SYSTEM",
      nextExposure: { plannedWorkoutId: plan.upperA2.id, scheduledDate: "2026-10-19", workoutName: "Upper A" },
    });
    // Based on the WORKING sets actually logged (warm-up excluded).
    expect(bench!.basedOn).toEqual({
      workoutSessionId: upperA.sessionId,
      sets: [1, 2, 3].map((i) => ({ order: i + 1, setType: "WORKING", reps: 12, load: KG(60) })),
    });

    // Canonical only, newest first: the SECONDARY session never appears.
    expect(overview.recentWorkouts.map((w) => w.workoutSessionId)).toEqual([lowerA.sessionId, upperA.sessionId]);
    expect(overview.recentWorkouts[1]).toEqual({
      workoutSessionId: upperA.sessionId,
      plannedWorkoutId: plan.upperA1.id,
      workoutName: "Upper A",
      startedAt: "2026-10-12T16:00:00.000Z",
      completedAt: "2026-10-12T17:05:00.000Z",
      completedLocalDate: "2026-10-12",
      durationSeconds: 3900,
      plannedWorkingSets: 5,
      completedWorkingSets: 4,
      completion: "PARTIAL",
      adaptations: { availableTime: false, equipment: false },
    });
    expect(overview.recentWorkouts[0]).toMatchObject({ completion: "FULL", plannedWorkingSets: 1, completedWorkingSets: 1, adaptations: { availableTime: true, equipment: true } });
  });

  it("PROGRESS-A-002: applied events match progression_applications exactly; Workout Preview carries the 'up from' provenance", async () => {
    const { athlete, plan, benchApplicationId } = await seedJourney();
    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, benchApplicationId));

    const overview = await service.getOverview(athlete);
    expect(overview.improving[0]).toMatchObject({ fromLoad: row!.expectedEffectiveLoad, toLoad: row!.appliedLoad, appliedAt: row!.appliedAt!.toISOString() });

    // The next exposure the overview names previews the progressed target, with provenance.
    const preview = await planRead.getWorkoutPreview(athlete, plan.upperA2.id);
    const benchPreview = preview!.exercises.find((e) => e.displayName === "Bench Press")!;
    expect(benchPreview.progression).toEqual({ applicationId: benchApplicationId, previousLoad: KG(60) });
    expect(benchPreview.sets.filter((s) => s.order > 1).map((s) => s.targetLoad)).toEqual([KG(62.5), KG(62.5), KG(62.5)]);
    // Warm-up keeps its authored load; OHP (pending only) has no provenance.
    expect(benchPreview.sets[0]!.targetLoad).toEqual(KG(20));
    expect(preview!.exercises.find((e) => e.displayName === "Overhead Press")!.progression).toBeUndefined();
    // The source occurrence itself is never affected by its own application.
    const sourcePreview = await planRead.getWorkoutPreview(athlete, plan.upperA1.id);
    expect(sourcePreview!.exercises[0]!.progression).toBeUndefined();

    const planOverview = await planRead.getCurrentPlanOverview(athlete);
    expect(planOverview.athleteLocalDate).toBe("2026-10-14");
  });

  it("PROGRESS-A-003: workout detail — prescribed order, completed sets only, substitute provenance, adaptations, progression events", async () => {
    const { athlete, upperA, lowerA, benchApplicationId } = await seedJourney();

    const detail = await service.getWorkoutDetail(athlete, upperA.sessionId);
    expect(detail.workout.workoutSessionId).toBe(upperA.sessionId);
    expect(detail.exercises.map((e) => [e.exerciseRef, e.plannedWorkingSets, e.sets.length])).toEqual([
      ["bench-press", 3, 4],
      ["overhead-press", 2, 1],
    ]);
    expect(detail.exercises[0]!.sets[0]).toEqual({ order: 1, setType: "WARM_UP", reps: 10, load: KG(20) });
    expect(detail.availableTime).toBeNull();
    expect(detail.progressionEvents).toEqual([expect.objectContaining({ applicationId: benchApplicationId, exerciseRef: "bench-press", fromLoad: KG(60), toLoad: KG(62.5), actor: "SYSTEM" })]);

    const adapted = await service.getWorkoutDetail(athlete, lowerA.sessionId);
    expect(adapted.exercises[0]).toMatchObject({ exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", substitution: { authoredDisplayName: "Bench Press" } });
    expect(adapted.availableTime).toEqual({ availableMinutes: 30 });
    expect(adapted.progressionEvents).toEqual([]);
  });

  it("PROGRESS-A-004: SECONDARY, foreign and unknown sessions are the same 404", async () => {
    const { athlete, secondary, upperA } = await seedJourney();
    const other = await createAthlete();

    await expect(service.getWorkoutDetail(athlete, secondary.sessionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getWorkoutDetail(other, upperA.sessionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getWorkoutDetail(athlete, createEntityId())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("PROGRESS-A-005: exercise history is per PERFORMED identity — substitutes never merged, SECONDARY excluded, foreign/unknown 404", async () => {
    const { athlete, upperA, lowerA } = await seedJourney();
    const other = await createAthlete();

    const bench = await service.getExerciseHistory(athlete, "bench-press", {});
    expect(bench.displayName).toBe("Bench Press");
    expect(bench.exposures.map((e) => e.workoutSessionId)).toEqual([upperA.sessionId]);
    expect(bench.exposures[0]).toMatchObject({ workoutName: "Upper A", isSubstitute: false, completedAt: "2026-10-12T17:05:00.000Z" });
    expect(bench.exposures[0]!.sets.map((s) => s.reps)).toEqual([10, 12, 12, 12]);
    expect(bench.nextCursor).toBeNull();

    const dumbbell = await service.getExerciseHistory(athlete, "dumbbell-bench-press", {});
    expect(dumbbell.exposures).toEqual([expect.objectContaining({ workoutSessionId: lowerA.sessionId, isSubstitute: true })]);

    await expect(service.getExerciseHistory(other, "bench-press", {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getExerciseHistory(athlete, "never-performed", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("PROGRESS-A-006: keyset pagination is complete and stable, even for completions inside the same millisecond", async () => {
    const { athlete, upperA, lowerA } = await seedJourney();
    // Two sessions that differ only in microseconds — a millisecond cursor would skip one.
    await db.execute(sql`UPDATE app.workout_sessions SET completed_at = '2026-10-13 09:00:00.000100+00' WHERE id = ${upperA.sessionId}`);
    await db.execute(sql`UPDATE app.workout_sessions SET completed_at = '2026-10-13 09:00:00.000900+00' WHERE id = ${lowerA.sessionId}`);

    const first = await service.getWorkoutHistory(athlete, { limit: 1 });
    expect(first.items.map((i) => i.workoutSessionId)).toEqual([lowerA.sessionId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.getWorkoutHistory(athlete, { limit: 1, before: first.nextCursor! });
    expect(second.items.map((i) => i.workoutSessionId)).toEqual([upperA.sessionId]);
    expect(second.nextCursor).toBeNull();

    const all = await service.getWorkoutHistory(athlete, {});
    expect(all.items.map((i) => i.workoutSessionId)).toEqual([lowerA.sessionId, upperA.sessionId]);
    expect(all.nextCursor).toBeNull();
  });

  it("PROGRESS-A-007: a malformed cursor is a 400; a cursor naming another athlete's row only moves the boundary inside the caller's own history", async () => {
    const { athlete, upperA } = await seedJourney();
    const other = await createAthlete();

    await expect(service.getWorkoutHistory(athlete, { before: "not-a-cursor" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getExerciseHistory(athlete, "bench-press", { before: encodeProgressCursor({ completedAt: "2026-02-31 10:00:00+00", id: createEntityId() }) })).rejects.toBeInstanceOf(BadRequestException);

    const crafted = encodeProgressCursor({ completedAt: "2027-01-01 00:00:00+00", id: upperA.sessionId });
    expect(decodeProgressCursor(crafted)).toBeDefined();
    expect((await service.getWorkoutHistory(other, { before: crafted })).items).toEqual([]);
  });

  it("PROGRESS-B-TZ-001: history days are derived in the athlete's TRAINING time zone — the same UTC instant is a different day for a different zone, never the machine's", async () => {
    // 22:30 UTC on 18 Oct = 00:30 on 19 Oct in Prague, 18:30 on 18 Oct in New York.
    const completedAt = new Date("2026-10-18T22:30:00.000Z");
    const expectations: [string | null, string][] = [
      ["Europe/Prague", "2026-10-19"],
      ["America/New_York", "2026-10-18"],
      // No training zone yet: the Schedule Calendar Authority's ordinary-read legacy UTC fallback.
      [null, "2026-10-18"],
    ];
    for (const [zone, expectedDay] of expectations) {
      const athlete = await createAthlete(zone);
      const plan = await seedPlan(athlete.athleteProfileId);
      const session = await completeSession(athlete.userId, plan.upperA1, {
        startedAt: new Date("2026-10-18T21:30:00.000Z"),
        completedAt,
        claim: true,
        performed: [{ exerciseOrder: 1, sets: [{ setType: "WORKING", reps: 10, kg: 60 }] }],
      });

      const overview = await service.getOverview(athlete);
      const history = await service.getWorkoutHistory(athlete, {});
      const detail = await service.getWorkoutDetail(athlete, session.sessionId);
      const exercise = await service.getExerciseHistory(athlete, "bench-press", {});

      // Workout history, workout detail and exercise history agree on ONE day; the instant is kept for audit.
      expect([overview.recentWorkouts[0]!.completedLocalDate, history.items[0]!.completedLocalDate, detail.workout.completedLocalDate, exercise.exposures[0]!.completedLocalDate]).toEqual([expectedDay, expectedDay, expectedDay, expectedDay]);
      expect(detail.workout.completedAt).toBe("2026-10-18T22:30:00.000Z");
      // The authored scheduled date (Mon 12 Oct) is never used as the completion day.
      expect(detail.workout.completedLocalDate).not.toBe("2026-10-12");
    }
  });

  // ---------------------------------------------------------------------
  // Slice C — progression feedback + next exposure. "Next Monday" is the
  // progressed occurrence (cycle 2 Upper A, 2026-10-19).
  // ---------------------------------------------------------------------
  const NEXT_MONDAY = new Date("2026-10-19T08:00:00.000Z");
  const workingLoads = (preview: WorkoutPreviewV1, prescriptionExerciseId: string) =>
    preview.prescription.exercises.find((e) => e.prescriptionExerciseId === prescriptionExerciseId)!.sets.filter((set) => set.setType === "WORKING").map((set) => set.targetLoad);

  it("PROGRESS-C-001: one authority — Progress 60 → 62.5, the next-exposure preview and the START prescription all carry 62.5 kg; foreign athletes get nothing", async () => {
    const { athlete, plan, benchApplicationId } = await seedJourney();
    const other = await createAthlete();

    const [bench] = (await service.getOverview(athlete)).improving;
    expect(bench!.nextExposure!.plannedWorkoutId).toBe(plan.upperA2.id);
    // A future workout outside the displayed cycle is previewable by its exact id (same resolver as any preview).
    const preview = (await planRead.getWorkoutPreview(athlete, bench!.nextExposure!.plannedWorkoutId))!;
    const benchExercise = preview.exercises.find((e) => e.plannedExerciseId === plan.upperA2.exercises[0]!.id)!;
    expect(benchExercise.progression).toEqual({ applicationId: benchApplicationId, previousLoad: bench!.fromLoad });
    // The prescription Workout Preview hands to START (mobile passes it verbatim) is the same 62.5 kg.
    expect(workingLoads(preview, plan.upperA2.exercises[0]!.id)).toEqual([bench!.toLoad, bench!.toLoad, bench!.toLoad]);
    expect(preview.displayStatus).toBe("PLANNED");

    expect(await planRead.getWorkoutPreview(other, plan.upperA2.id)).toBeUndefined();
  });

  it("PROGRESS-C-002: Plan's session-level signal comes from each occurrence's own Workout Preview — never on rest days, completed or un-progressed workouts", async () => {
    const { athlete, plan } = await seedJourney();

    // This week (cycle 1): Upper A COMPLETED, nothing progressed yet -> no signal anywhere.
    const thisWeek = await planRead.getCurrentPlanOverview(athlete);
    expect(thisWeek.sessions.filter((s) => s.hasAppliedProgression)).toEqual([]);

    // Next week (cycle 2): only Upper A (Bench 62.5) carries the signal.
    const nextWeekPlan = new PlanReadService(db, fixedClock(NEXT_MONDAY));
    const nextWeek = await nextWeekPlan.getCurrentPlanOverview(athlete);
    expect(nextWeek.sessions.filter((s) => s.hasAppliedProgression).map((s) => s.plannedWorkoutId)).toEqual([plan.upperA2.id]);
    expect(nextWeek.sessions.find((s) => s.plannedWorkoutId === null)!.hasAppliedProgression).toBe(false);
  });

  it("PROGRESS-C-003: Available-Time keeps the progressed target on retained sets and drops a removed exercise entirely", async () => {
    const { athlete, plan, benchApplicationId } = await seedJourney();
    const [benchSlot, ohpSlot] = plan.upperA2.exercises;
    await db.update(plannedExercises).set({ priorityTier: "TIER_1", minimumWorkingSets: 2 }).where(eq(plannedExercises.id, benchSlot!.id));
    await db.update(plannedExercises).set({ priorityTier: "TIER_2", minimumWorkingSets: 0 }).where(eq(plannedExercises.id, ohpSlot!.id));
    await db.update(plannedSets).set({ restSeconds: 90 }).where(inArray(plannedSets.plannedExerciseId, [benchSlot!.id, ohpSlot!.id]));

    const preview = (await new PlanReadService(db, fixedClock(NEXT_MONDAY)).getWorkoutPreview(athlete, plan.upperA2.id))!;
    // 8 min: OHP (TIER_2, min 0) is removed entirely; Bench (TIER_1) is untouched.
    const atPreview = await new AvailableTimePreviewService(db).preview(athlete, plan.upperA2.id, 8);
    expect(atPreview.result).toBe("ADJUST_SESSION");
    const application = availableTimeApplicationFromPreview(atPreview);
    if (!application.ok) throw new Error(application.error.reason);
    const selected = selectAvailableTimePrescription(preview.prescription, application.value);
    if (!selected.ok) throw new Error(selected.error);

    expect(selected.value.exercises.map((e) => e.prescriptionExerciseId)).toEqual([benchSlot!.id]);
    expect(selected.value.exercises[0]!.sets.filter((set) => set.setType === "WORKING").map((set) => set.targetLoad)).toEqual([KG(62.5), KG(62.5), KG(62.5)]);
    // Provenance on the retained exercise is unchanged.
    expect(preview.exercises.find((e) => e.plannedExerciseId === benchSlot!.id)!.progression).toEqual({ applicationId: benchApplicationId, previousLoad: KG(60) });
  });

  it("PROGRESS-C-004: an equipment substitute never inherits the authored exercise's progression (target or 'up from'), and Plan's signal follows", async () => {
    const { athlete, plan } = await seedJourney();
    const clock = fixedClock(NEXT_MONDAY);
    const noBarbell = ["barbell-rack", "flat-bench", "adjustable-bench", "dumbbells", "cable-station", "lat-pulldown-station", "leg-press-machine", "leg-curl-machine", "hack-squat-machine"];
    const request = { plannedWorkoutId: plan.upperA2.id, catalogVersion: EXERCISE_EQUIPMENT_CATALOG_VERSION_V1, availableEquipmentIds: noBarbell };
    const equipmentPreview = await new EquipmentAdaptationPreviewService(db, clock).preview(athlete, request);
    expect(equipmentPreview.result).toBe("ADJUST_SESSION");
    await new EquipmentAdaptationApplyService(db, clock).apply(athlete, { ...request, previewFingerprint: equipmentPreview.previewFingerprint });

    const nextWeekPlan = new PlanReadService(db, clock);
    const preview = (await nextWeekPlan.getWorkoutPreview(athlete, plan.upperA2.id))!;
    const substituted = preview.exercises.find((e) => e.plannedExerciseId === plan.upperA2.exercises[0]!.id)!;
    expect(substituted.displayName).toBe("Dumbbell Bench Press");
    expect(substituted.substitution?.authoredExerciseRef).toBe("bench-press");
    expect(substituted.progression).toBeUndefined();
    expect(workingLoads(preview, plan.upperA2.exercises[0]!.id)).not.toContainEqual(KG(62.5));
    // No exercise of today's effective workout is progressed any more -> no Plan signal.
    expect((await nextWeekPlan.getCurrentPlanOverview(athlete)).sessions.find((s) => s.plannedWorkoutId === plan.upperA2.id)!.hasAppliedProgression).toBe(false);
  });

  it("PROGRESS-C-005: a missed-workout move keeps the occurrence's progression; next exposure and Plan follow the EFFECTIVE date", async () => {
    const { athlete, plan, benchApplicationId } = await seedJourney();
    const [block] = await db.select({ blockId: trainingCycles.trainingBlockId }).from(plannedWorkouts).innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId)).where(eq(plannedWorkouts.id, plan.upperA2.id));
    const overlayId = createEntityId();
    await db.insert(missedWorkoutScheduleApplications).values({
      id: overlayId,
      athleteProfileId: athlete.athleteProfileId,
      programVersionId: plan.programVersionId,
      trainingBlockId: block!.blockId,
      policyVersion: "missed-workout/v1",
      previewFingerprint: "c".repeat(64),
      athleteLocalDate: "2026-10-14",
      trainingTimeZone: "Europe/Prague",
      missedPlannedWorkoutId: plan.upperB1.id,
      reasonCode: "SINGLE_MISSED_WORKOUT",
      appliedByUserId: athlete.userId,
      appliedAt: NOW,
      status: "ACTIVE",
    });
    // Next week's Upper A moves Monday -> Tuesday 2026-10-20 (same plannedWorkoutId).
    await db.insert(missedWorkoutScheduleAssignments).values({ id: createEntityId(), applicationId: overlayId, sequencePosition: 0, plannedWorkoutId: plan.upperA2.id, assignmentKind: "ROLL_FORWARD", authoredScheduledLocalDate: "2026-10-19", effectiveScheduledLocalDate: "2026-10-20" });

    const [bench] = (await service.getOverview(athlete)).improving;
    expect(bench!.nextExposure).toEqual({ plannedWorkoutId: plan.upperA2.id, scheduledDate: "2026-10-20", workoutName: "Upper A" });
    expect((await planRead.getWorkoutPreview(athlete, plan.upperA2.id))!.exercises[0]!.progression?.applicationId).toBe(benchApplicationId);

    const movedDay = await new PlanReadService(db, fixedClock(new Date("2026-10-20T08:00:00.000Z"))).getCurrentPlanOverview(athlete);
    expect(movedDay.sessions.find((s) => s.plannedWorkoutId === plan.upperA2.id)).toMatchObject({ scheduledDate: "2026-10-20", scheduleSource: "ADAPTED", displayStatus: "TODAY", hasAppliedProgression: true });
  });

  // ------------------------------------------------ Slice D — completed workout semantics

  it("PROGRESS-D-001: Plan exposes the CANONICAL completed session id + athlete-local completion day; completed occurrences are no longer ordinarily startable", async () => {
    const { athlete, plan, upperA, secondary, lowerA } = await seedJourney();

    const overview = await planRead.getCurrentPlanOverview(athlete);
    expect(overview.athleteLocalDate).toBe("2026-10-14");
    const row = (id: string) => overview.sessions.find((s) => s.plannedWorkoutId === id)!;
    expect(row(plan.upperA1.id)).toMatchObject({ displayStatus: "COMPLETED", completedWorkoutSessionId: upperA.sessionId, hasAppliedProgression: false });
    // Completed today (08:40 Prague) — adapted (Available-Time + equipment substitute) still maps to its canonical session.
    expect(row(plan.lowerA1.id)).toMatchObject({ displayStatus: "COMPLETED", completedWorkoutSessionId: lowerA.sessionId });
    // Matrix #1: the current-cycle canonical completion today is the server's completed-today fact (Monday's is not).
    expect(overview.completedToday).toEqual({ plannedWorkoutId: plan.lowerA1.id, workoutSessionId: lowerA.sessionId, workoutName: "Lower A", completedLocalDate: "2026-10-14" });
    // Not performed / rest days: absent.
    expect(row(plan.upperB1.id)).not.toHaveProperty("completedWorkoutSessionId");
    for (const rest of overview.sessions.filter((s) => s.plannedWorkoutId === null)) expect(rest).not.toHaveProperty("completedWorkoutSessionId");
    // The SECONDARY session of Upper A never appears.
    expect(JSON.stringify(overview)).not.toContain(secondary.sessionId);

    expect(await planRead.getWorkoutPreview(athlete, plan.upperA1.id)).toMatchObject({ displayStatus: "COMPLETED", canStart: false, completedWorkoutSessionId: upperA.sessionId });
    expect(await planRead.getWorkoutPreview(athlete, plan.lowerA1.id)).toMatchObject({ displayStatus: "COMPLETED", canStart: false, completedWorkoutSessionId: lowerA.sessionId });
    const open = (await planRead.getWorkoutPreview(athlete, plan.upperB1.id))!;
    expect(open).toMatchObject({ displayStatus: "PLANNED", canStart: true });
    expect(open).not.toHaveProperty("completedWorkoutSessionId");

    // The id is directly usable for the canonical history detail; adaptation provenance is retained there.
    const adapted = await service.getWorkoutDetail(athlete, row(plan.lowerA1.id).completedWorkoutSessionId!);
    expect(adapted.workout.workoutSessionId).toBe(lowerA.sessionId);
    expect(adapted.availableTime).toEqual({ availableMinutes: 30 });
    expect(adapted.exercises[0]).toMatchObject({ substitution: { authoredDisplayName: "Bench Press" } });
  });

  it("PROGRESS-D-002: a SECONDARY-only (unclaimed) completed session never makes the occurrence COMPLETED; another athlete's ids never leak", async () => {
    const { athlete, plan, upperA, lowerA } = await seedJourney();
    const other = await createAthlete();
    await seedPlan(other.athleteProfileId);
    const orphan = await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-14T07:00:00.000Z"), completedAt: new Date("2026-10-14T08:00:00.000Z"), claim: false, performed: [] });

    const overview = await planRead.getCurrentPlanOverview(athlete);
    const upperB = overview.sessions.find((s) => s.plannedWorkoutId === plan.upperB1.id)!;
    expect(upperB.displayStatus).toBe("PLANNED");
    // The unclaimed session finished later today, yet completed-today stays the canonical Lower A.
    expect(overview.completedToday?.workoutSessionId).toBe(lowerA.sessionId);
    expect(upperB).not.toHaveProperty("completedWorkoutSessionId");
    expect((await planRead.getWorkoutPreview(athlete, plan.upperB1.id))!.canStart).toBe(true);

    const foreignOverview = await planRead.getCurrentPlanOverview(other);
    expect(foreignOverview).not.toHaveProperty("completedToday");
    const foreign = JSON.stringify(foreignOverview);
    for (const id of [upperA.sessionId, lowerA.sessionId, orphan.sessionId]) expect(foreign).not.toContain(id);
    expect(await planRead.getWorkoutPreview(other, plan.upperA1.id)).toBeUndefined();
  });

  it("PROGRESS-D-003: a missed-workout move completed on its new day is completed THAT day — same plannedWorkoutId, no duplicate row; yesterday's completion stays yesterday's", async () => {
    const { athlete, plan, lowerA } = await seedJourney();
    const [block] = await db.select({ blockId: trainingCycles.trainingBlockId }).from(plannedWorkouts).innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId)).where(eq(plannedWorkouts.id, plan.upperB1.id));
    const overlayId = createEntityId();
    await db.insert(missedWorkoutScheduleApplications).values({
      id: overlayId,
      athleteProfileId: athlete.athleteProfileId,
      programVersionId: plan.programVersionId,
      trainingBlockId: block!.blockId,
      policyVersion: "missed-workout/v1",
      previewFingerprint: "d".repeat(64),
      athleteLocalDate: "2026-10-14",
      trainingTimeZone: "Europe/Prague",
      missedPlannedWorkoutId: plan.lowerA1.id,
      reasonCode: "SINGLE_MISSED_WORKOUT",
      appliedByUserId: athlete.userId,
      appliedAt: NOW,
      status: "ACTIVE",
    });
    // Upper B moves Friday -> Thursday 2026-10-15 and is completed that Thursday evening (Prague).
    await db.insert(missedWorkoutScheduleAssignments).values({ id: createEntityId(), applicationId: overlayId, sequencePosition: 0, plannedWorkoutId: plan.upperB1.id, assignmentKind: "ROLL_FORWARD", authoredScheduledLocalDate: "2026-10-16", effectiveScheduledLocalDate: "2026-10-15" });
    const moved = await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-15T16:00:00.000Z"), completedAt: new Date("2026-10-15T17:00:00.000Z"), claim: true, performed: [] });

    const thursday = await new PlanReadService(db, fixedClock(new Date("2026-10-15T19:00:00.000Z"))).getCurrentPlanOverview(athlete);
    expect(thursday.athleteLocalDate).toBe("2026-10-15");
    expect(thursday.sessions.filter((s) => s.plannedWorkoutId === plan.upperB1.id)).toEqual([
      expect.objectContaining({ scheduledDate: "2026-10-15", scheduleSource: "ADAPTED", displayStatus: "COMPLETED", completedWorkoutSessionId: moved.sessionId }),
    ]);
    expect(thursday.completedToday).toMatchObject({ plannedWorkoutId: plan.upperB1.id, workoutSessionId: moved.sessionId, completedLocalDate: "2026-10-15" });
    // Yesterday's completion is still COMPLETED in Plan, but no longer today's fact.
    expect(thursday.sessions.find((s) => s.plannedWorkoutId === plan.lowerA1.id)).toMatchObject({ completedWorkoutSessionId: lowerA.sessionId });
  });

  it("PROGRESS-D-004: the completion day follows the TRAINING time zone, not UTC — a late-evening finish belongs to that local day", async () => {
    const athlete = await createAthlete("America/New_York");
    const plan = await seedPlan(athlete.athleteProfileId);
    // 2026-10-14 23:30 New York = 2026-10-15 03:30 UTC.
    const late = await completeSession(athlete.userId, plan.lowerA1, { startedAt: new Date("2026-10-15T02:30:00.000Z"), completedAt: new Date("2026-10-15T03:30:00.000Z"), claim: true, performed: [] });

    const overview = await new PlanReadService(db, fixedClock(new Date("2026-10-15T03:45:00.000Z"))).getCurrentPlanOverview(athlete);
    expect(overview.athleteLocalDate).toBe("2026-10-14");
    expect(overview.sessions.find((s) => s.plannedWorkoutId === plan.lowerA1.id)).toMatchObject({ completedWorkoutSessionId: late.sessionId });
    expect(overview.completedToday).toMatchObject({ workoutSessionId: late.sessionId, completedLocalDate: "2026-10-14" });
  });

  // ------------------------------------- Slice D closure — cycle-independent completed-today

  // Wednesday 2026-10-21, 12:00 Prague: Plan now displays Cycle 2 (2026-10-19..25).
  const CYCLE_2_NOW = new Date("2026-10-21T10:00:00.000Z");
  const planReadAt = (instant: Date) => new PlanReadService(db, fixedClock(instant));

  async function rollForward(athlete: { readonly userId: string; readonly athleteProfileId: string }, plan: Awaited<ReturnType<typeof seedPlan>>, workout: PlannedWorkoutFixture, authored: string, effective: string | null) {
    const [block] = await db.select({ blockId: trainingCycles.trainingBlockId }).from(plannedWorkouts).innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId)).where(eq(plannedWorkouts.id, workout.id));
    const overlayId = createEntityId();
    await db.insert(missedWorkoutScheduleApplications).values({
      id: overlayId,
      athleteProfileId: athlete.athleteProfileId,
      programVersionId: plan.programVersionId,
      trainingBlockId: block!.blockId,
      policyVersion: "missed-workout/v1",
      previewFingerprint: createEntityId().replaceAll("-", "").padEnd(64, "0"),
      athleteLocalDate: authored,
      trainingTimeZone: "Europe/Prague",
      missedPlannedWorkoutId: workout.id,
      reasonCode: "SINGLE_MISSED_WORKOUT",
      appliedByUserId: athlete.userId,
      appliedAt: NOW,
      status: "ACTIVE",
    });
    await db.insert(missedWorkoutScheduleAssignments).values({ id: createEntityId(), applicationId: overlayId, sequencePosition: 0, plannedWorkoutId: workout.id, assignmentKind: "ROLL_FORWARD", authoredScheduledLocalDate: authored, effectiveScheduledLocalDate: effective });
  }

  it("PROGRESS-D-CT-001: a PREVIOUS-cycle occurrence completed today is today's fact although Plan shows Cycle 2 only — never duplicated into sessions", async () => {
    const athlete = await createAthlete();
    const plan = await seedPlan(athlete.athleteProfileId);
    // Cycle 1's Upper B (authored Fri 2026-10-16) was never done; it is finished late, today, in Cycle 2's week.
    const late = await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-21T06:00:00.000Z"), completedAt: new Date("2026-10-21T07:00:00.000Z"), claim: true, performed: [] });

    const overview = await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete);
    expect(overview.currentBlock?.currentCycleOrder).toBe(2);
    expect(overview.sessions.some((s) => s.plannedWorkoutId === plan.upperB1.id)).toBe(false);
    expect(overview.completedToday).toEqual({ plannedWorkoutId: plan.upperB1.id, workoutSessionId: late.sessionId, workoutName: "Upper B", completedLocalDate: "2026-10-21" });
    // The id opens the canonical history.
    expect((await service.getWorkoutDetail(athlete, overview.completedToday!.workoutSessionId)).workout.workoutSessionId).toBe(late.sessionId);
  });

  it("PROGRESS-D-CT-002: a previous-cycle MISSED/rolled-forward occurrence completed today is today's fact; its effective row stays out of Cycle 2", async () => {
    const athlete = await createAthlete();
    const plan = await seedPlan(athlete.athleteProfileId);
    // Upper B rolled Fri 2026-10-16 -> Sun 2026-10-18 (still Cycle 1), then actually done on Wed 2026-10-21.
    await rollForward(athlete, plan, plan.upperB1, "2026-10-16", "2026-10-18");
    const done = await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-21T08:00:00.000Z"), completedAt: new Date("2026-10-21T09:00:00.000Z"), claim: true, performed: [] });

    const overview = await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete);
    expect(overview.sessions.some((s) => s.plannedWorkoutId === plan.upperB1.id)).toBe(false);
    expect(overview.completedToday).toMatchObject({ plannedWorkoutId: plan.upperB1.id, workoutSessionId: done.sessionId, completedLocalDate: "2026-10-21" });
    // The rolled occurrence's own Preview is read-only, same canonical id.
    expect(await planReadAt(CYCLE_2_NOW).getWorkoutPreview(athlete, plan.upperB1.id)).toMatchObject({ canStart: false, completedWorkoutSessionId: done.sessionId });
  });

  it("PROGRESS-D-CT-003: yesterday's completion, a SECONDARY-only (unclaimed) completion and nothing at all -> absent", async () => {
    const athlete = await createAthlete();
    const plan = await seedPlan(athlete.athleteProfileId);
    expect(await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete)).not.toHaveProperty("completedToday");
    // Yesterday (Tue 2026-10-20, 20:00 Prague) — canonical, but not today.
    await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-20T17:00:00.000Z"), completedAt: new Date("2026-10-20T18:00:00.000Z"), claim: true, performed: [] });
    // Today — but no claim (a SECONDARY / unclaimed session never represents an occurrence).
    await completeSession(athlete.userId, plan.upperA2, { startedAt: new Date("2026-10-21T06:00:00.000Z"), completedAt: new Date("2026-10-21T07:00:00.000Z"), claim: false, performed: [] });

    expect(await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete)).not.toHaveProperty("completedToday");
  });

  it("PROGRESS-D-CT-004: foreign data never becomes the caller's fact — neither another athlete's completion nor a claim on another athlete's planned workout", async () => {
    const athlete = await createAthlete();
    await seedPlan(athlete.athleteProfileId);
    const other = await createAthlete();
    const otherPlan = await seedPlan(other.athleteProfileId);
    const otherDone = await completeSession(other.userId, otherPlan.upperA2, { startedAt: new Date("2026-10-21T06:00:00.000Z"), completedAt: new Date("2026-10-21T07:00:00.000Z"), claim: true, performed: [] });
    // Defence in depth: a (corrupt) claim of the caller's own session on the OTHER athlete's planned workout.
    const forged = await completeSession(athlete.userId, otherPlan.lowerA2, { startedAt: new Date("2026-10-21T08:00:00.000Z"), completedAt: new Date("2026-10-21T09:00:00.000Z"), claim: true, performed: [] });

    const overview = await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete);
    expect(overview).not.toHaveProperty("completedToday");
    expect(JSON.stringify(overview)).not.toContain(otherDone.sessionId);
    expect(JSON.stringify(overview)).not.toContain(forged.sessionId);
    expect((await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(other)).completedToday?.workoutSessionId).toBe(otherDone.sessionId);
  });

  it("PROGRESS-D-CT-005: several canonical planned workouts completed today -> the most recently completed one, deterministically", async () => {
    const athlete = await createAthlete();
    const plan = await seedPlan(athlete.athleteProfileId);
    await completeSession(athlete.userId, plan.upperB1, { startedAt: new Date("2026-10-21T05:00:00.000Z"), completedAt: new Date("2026-10-21T06:00:00.000Z"), claim: true, performed: [] });
    const latest = await completeSession(athlete.userId, plan.upperA2, { startedAt: new Date("2026-10-21T08:00:00.000Z"), completedAt: new Date("2026-10-21T09:30:00.000Z"), claim: true, performed: [] });
    await completeSession(athlete.userId, plan.lowerA2, { startedAt: new Date("2026-10-21T07:00:00.000Z"), completedAt: new Date("2026-10-21T08:00:00.000Z"), claim: true, performed: [] });

    for (let i = 0; i < 3; i++) {
      expect((await planReadAt(CYCLE_2_NOW).getCurrentPlanOverview(athlete)).completedToday).toEqual({ plannedWorkoutId: plan.upperA2.id, workoutSessionId: latest.sessionId, workoutName: "Upper A", completedLocalDate: "2026-10-21" });
    }
  });

  it("PROGRESS-D-CT-006: the same completedAt instant is a different local day in Prague and New York — completed-today follows each athlete's training time zone", async () => {
    // 2026-10-20 23:30 UTC = Wed 01:30 Prague = Tue 19:30 New York.
    const instant = new Date("2026-10-20T23:30:00.000Z");
    const prague = await createAthlete("Europe/Prague");
    const pragueDone = await completeSession(prague.userId, (await seedPlan(prague.athleteProfileId)).upperB1, { startedAt: new Date(instant.getTime() - 3_600_000), completedAt: instant, claim: true, performed: [] });
    const newYork = await createAthlete("America/New_York");
    const newYorkDone = await completeSession(newYork.userId, (await seedPlan(newYork.athleteProfileId)).upperB1, { startedAt: new Date(instant.getTime() - 3_600_000), completedAt: instant, claim: true, performed: [] });

    const shortlyAfter = planReadAt(new Date("2026-10-20T23:45:00.000Z"));
    expect((await shortlyAfter.getCurrentPlanOverview(prague)).completedToday).toMatchObject({ workoutSessionId: pragueDone.sessionId, completedLocalDate: "2026-10-21" });
    expect((await shortlyAfter.getCurrentPlanOverview(newYork)).completedToday).toMatchObject({ workoutSessionId: newYorkDone.sessionId, completedLocalDate: "2026-10-20" });

    // Wed 2026-10-21 12:00 UTC: still Wednesday's workout in Prague; New York's was Tuesday's.
    const nextNoon = planReadAt(new Date("2026-10-21T12:00:00.000Z"));
    expect((await nextNoon.getCurrentPlanOverview(prague)).completedToday?.workoutSessionId).toBe(pragueDone.sessionId);
    expect(await nextNoon.getCurrentPlanOverview(newYork)).not.toHaveProperty("completedToday");
  });

  it("PROGRESS-A-008: an athlete without history gets a calm empty overview", async () => {
    const athlete = await createAthlete();
    const overview = await service.getOverview(athlete);
    expect(overview).toEqual({ schemaVersion: 1, athleteLocalDate: "2026-10-14", snapshot: { block: null, thisWeek: null }, improving: [], recentWorkouts: [] });
    expect(await service.getWorkoutHistory(athlete, {})).toEqual({ items: [], nextCursor: null });
  });
});
