import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  athleteProfiles,
  availableTimeApplications,
  createDatabaseClient,
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
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { createEntityId, selectAvailableTimePrescription, type AvailableTimeApplicationV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { availableTimeApplicationFromPreview, type StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { ensureProgressionEvaluateSessionQueues } from "@vostivo/progression-application";
import { fixedClock } from "../common/clock.js";
import { processWorkoutCommand } from "../workout/workout-command-processing.js";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { PlanReadService } from "./plan-read.service.js";

/**
 * Missed Workout V1 Slice D — cross-feature regression (real Postgres, the
 * REAL sync command path): after a schedule Apply, the rolled-forward
 * workout is Today's workout and starts through the ORDINARY START (and the
 * Available-Time adjusted START) with its ORIGINAL PlannedWorkout id — no
 * synthetic workout, no special session type; the occurrence claim belongs
 * to that same id; progression stays untouched by the Apply itself.
 *
 * Locked example (Europe/Prague), clock Wednesday 2026-10-07 10:00 local.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const WED = fixedClock(new Date("2026-10-07T08:00:00Z"));

const WORKOUTS = [
  { key: "A", name: "Upper A", cycle: 0, order: 0, date: "2026-10-05" },
  { key: "B", name: "Lower A", cycle: 0, order: 1, date: "2026-10-07" },
  { key: "C", name: "Upper B", cycle: 0, order: 2, date: "2026-10-09" },
  { key: "D", name: "Lower B", cycle: 1, order: 0, date: "2026-10-12" },
] as const;

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

describe("Missed Workout Slice D — cross-feature regression (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
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

  /** The locked plan, every workout with a real Available-Time-ready structure (Bench TIER_1/min 2 x3, OHP TIER_2/min 0 x2, 90 s rest). */
  async function seed(): Promise<{ athlete: Athlete; ids: Record<string, string> }> {
    const userId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    const athleteProfileId = createEntityId();
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC", trainingTimeZone: "Europe/Prague" });
    userIds.push(userId);
    const programId = createEntityId();
    await db.insert(programs).values({ id: programId, athleteProfileId, name: "Program", status: "ACTIVE" });
    const versionId = createEntityId();
    await db.insert(programVersions).values({ id: versionId, programId, versionNumber: 1, status: "ACTIVE", activatedAt: new Date("2026-09-01T00:00:00Z") });
    const blockId = createEntityId();
    await db.insert(trainingBlocks).values({ id: blockId, programVersionId: versionId, name: "Block 1", goal: "Hypertrophy", orderIndex: 0, cycleCount: 2, focusAreas: [] });
    const cycleIds = [createEntityId(), createEntityId()];
    await db.insert(trainingCycles).values([
      { id: cycleIds[0]!, trainingBlockId: blockId, orderIndex: 0, startDate: "2026-10-05", endDate: "2026-10-11" },
      { id: cycleIds[1]!, trainingBlockId: blockId, orderIndex: 1, startDate: "2026-10-12", endDate: "2026-10-18" },
    ]);
    const ids: Record<string, string> = {};
    for (const w of WORKOUTS) {
      const id = createEntityId();
      ids[w.key] = id;
      await db.insert(plannedWorkouts).values({ id, trainingCycleId: cycleIds[w.cycle]!, name: w.name, orderIndex: w.order, scheduledDate: w.date, estimatedDurationMinutes: 60, status: "PLANNED" });
      for (const [index, spec] of [
        { ref: "bench-press", name: "Bench Press", tier: "TIER_1", min: 2, sets: 3, load: 60000 },
        { ref: "overhead-press", name: "Overhead Press", tier: "TIER_2", min: 0, sets: 2, load: 30000 },
      ].entries()) {
        const exerciseId = createEntityId();
        await db.insert(plannedExercises).values({ id: exerciseId, plannedWorkoutId: id, exerciseRef: spec.ref, displayName: spec.name, orderIndex: index + 1, priorityTier: spec.tier as "TIER_1" | "TIER_2", minimumWorkingSets: spec.min });
        for (let order = 1; order <= spec.sets; order++) {
          await db.insert(plannedSets).values({
            id: createEntityId(), plannedExerciseId: exerciseId, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, restSeconds: 90,
            setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: spec.load, loadUnit: "KG", loadBasis: "TOTAL",
          });
        }
      }
    }
    return { athlete: { userId, athleteProfileId }, ids };
  }

  async function applyWednesdayRollForward(athlete: Athlete): Promise<void> {
    const preview = await new MissedWorkoutPreviewService(db, WED).preview(athlete);
    if (preview.result !== "ROLL_FORWARD") throw new Error(`expected ROLL_FORWARD, got ${preview.result}`);
    await new MissedWorkoutApplyService(db, WED).apply(athlete, preview.previewFingerprint);
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

  async function todaysWorkoutId(athlete: Athlete): Promise<string | null> {
    const overview = await new PlanReadService(db, WED).getCurrentPlanOverview(athlete);
    return overview.sessions.find((s) => s.displayStatus === "TODAY")?.plannedWorkoutId ?? null;
  }

  it("X-034/035: after Apply, Today = Upper A, and the ORDINARY START of it (real sync path) claims Upper A's own PlannedWorkout id", async () => {
    const { athlete, ids } = await seed();
    expect(await todaysWorkoutId(athlete)).toBe(ids.B); // before Apply: authored Wednesday = Lower A
    await applyWednesdayRollForward(athlete);
    const todayId = await todaysWorkoutId(athlete);
    expect(todayId).toBe(ids.A); // after Apply: the rolled-forward Upper A, not Lower A

    // Exactly what Today's Start Workout does: the normal Workout Preview -> its prescription -> START.
    const preview = await new PlanReadService(db, WED).getWorkoutPreview(athlete, todayId!);
    expect(preview?.prescription.prescriptionId).toBe(ids.A);
    const command = startCommand(preview!.prescription);
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");

    const claims = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, athlete.userId));
    expect(claims).toEqual([expect.objectContaining({ plannedWorkoutId: ids.A, canonicalWorkoutSessionId: command.workoutSessionId })]);
    // The overlay itself is untouched by the START.
    const overlay = await db.select().from(missedWorkoutScheduleApplications).where(eq(missedWorkoutScheduleApplications.athleteProfileId, athlete.athleteProfileId));
    expect(overlay.map((r) => r.status)).toEqual(["ACTIVE"]);
    expect((await new PlanReadService(db, WED).getCurrentPlanOverview(athlete)).sessions.find((s) => s.plannedWorkoutId === ids.A)?.displayStatus).toBe("IN_PROGRESS");
  });

  it("X-036/037: Available-Time previews and the adjusted START work on the rolled-forward workout's own id (VERIFIED, claim = Upper A)", async () => {
    const { athlete, ids } = await seed();
    await applyWednesdayRollForward(athlete);
    const todayId = await todaysWorkoutId(athlete);
    expect(todayId).toBe(ids.A);

    const atPreview = await new AvailableTimePreviewService(db).preview(athlete, todayId!, 8);
    expect(atPreview).toMatchObject({ plannedWorkoutId: ids.A, result: "ADJUST_SESSION" });
    const application = availableTimeApplicationFromPreview(atPreview);
    if (!application.ok) throw new Error("expected an applicable ADJUST_SESSION");
    const full = (await new PlanReadService(db, WED).getWorkoutPreview(athlete, todayId!))!.prescription;
    const adjusted = selectAvailableTimePrescription(full, application.value);
    if (!adjusted.ok) throw new Error(adjusted.error);
    const command = startCommand(adjusted.value, application.value);
    expect((await processWorkoutCommand(db, boss, athlete.userId, command)).outcome).toBe("APPLIED");

    const rows = await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.workoutSessionId, command.workoutSessionId));
    expect(rows).toEqual([expect.objectContaining({ plannedWorkoutId: ids.A, verificationStatus: "VERIFIED", scope: "TODAY_ONLY" })]);
    const claims = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, athlete.userId));
    expect(claims.map((c) => c.plannedWorkoutId)).toEqual([ids.A]);
  });

  it("X-038: a schedule Apply (GUIDED athlete too) creates no progression decision/application — and never starts a workout", async () => {
    const { athlete } = await seed();
    await applyWednesdayRollForward(athlete);
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, athlete.userId))).toHaveLength(0);
    expect(await db.select().from(progressionApplications).where(eq(progressionApplications.userId, athlete.userId))).toHaveLength(0);
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId))).toHaveLength(0);
  });
});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, ids))).map((r) => r.id);
  if (profileIds.length > 0) {
    const applicationIds = (await db.select({ id: missedWorkoutScheduleApplications.id }).from(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.athleteProfileId, profileIds))).map((r) => r.id);
    if (applicationIds.length > 0) {
      await db.delete(missedWorkoutScheduleAssignments).where(inArray(missedWorkoutScheduleAssignments.applicationId, applicationIds));
      await db.update(missedWorkoutScheduleApplications).set({ supersedesApplicationId: null }).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
      await db.delete(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
    }
  }
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
