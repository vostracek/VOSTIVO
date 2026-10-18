import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import type { MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { fixedClock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { MeProjectionService } from "../me/me-projection.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { PlanReadService } from "./plan-read.service.js";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice C, real Postgres
 * (`pnpm test:integration`). Deterministic: explicit fixture dates + a
 * fixed Clock only — never the dev seed's UTC-derived dates.
 *
 * Locked example (Europe/Prague):
 *   cycle 0 (10-05..10-11): Mon 10-05 A, Wed 10-07 B, Fri 10-09 C
 *   cycle 1 (10-12..10-18): Mon 10-12 D
 * Wednesday 2026-10-07: A missed; known slots Wed/Fri/Mon ->
 *   A -> Wed, B -> Fri, C -> Mon, D -> carryover (effective NULL).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const MON = "2026-10-05T08:00:00Z";
const WED = "2026-10-07T08:00:00Z";
const TUE = "2026-10-06T08:00:00Z";
const THU = "2026-10-08T08:00:00Z";
const SAT = "2026-10-10T08:00:00Z";

interface WorkoutSeed {
  readonly key: string;
  readonly date: string | null;
}
interface CycleSeed {
  readonly start: string;
  readonly end: string;
  readonly workouts: readonly WorkoutSeed[];
}
interface TestAthlete {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly actor: AuthenticatedActor;
}
interface Seeded {
  readonly programId: string;
  readonly versionId: string;
  readonly blockIds: string[];
  readonly ids: Record<string, string>;
}

const LOCKED: readonly CycleSeed[] = [
  { start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "A", date: "2026-10-05" }, { key: "B", date: "2026-10-07" }, { key: "C", date: "2026-10-09" }] },
  { start: "2026-10-12", end: "2026-10-18", workouts: [{ key: "D", date: "2026-10-12" }] },
];

async function createAthlete(db: Database, trainingTimeZone: string | null): Promise<TestAthlete> {
  const userId = createEntityId();
  await db.insert(users).values({ id: userId, status: "ACTIVE" });
  const athleteProfileId = createEntityId();
  await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC", trainingTimeZone });
  return { userId, athleteProfileId, actor: { userId, athleteProfileId } };
}

async function seedProgram(db: Database, athleteProfileId: string, blocks: readonly (readonly CycleSeed[])[], reverseInsert = false): Promise<Seeded> {
  const programId = createEntityId();
  await db.insert(programs).values({ id: programId, athleteProfileId, name: "Program", status: "ACTIVE" });
  const versionId = createEntityId();
  await db.insert(programVersions).values({ id: versionId, programId, versionNumber: 1, status: "ACTIVE", activatedAt: new Date("2026-09-01T00:00:00Z") });
  const ids: Record<string, string> = {};
  const blockIds = blocks.map(() => createEntityId());
  const order = <T,>(items: readonly T[]) => (reverseInsert ? [...items.entries()].reverse() : [...items.entries()]);
  for (const [b, cycles] of order(blocks)) {
    await db.insert(trainingBlocks).values({ id: blockIds[b]!, programVersionId: versionId, name: `Block ${b + 1}`, goal: "Hypertrophy", orderIndex: b, cycleCount: cycles.length, focusAreas: [] });
    for (const [c, cycle] of order(cycles)) {
      const cycleId = createEntityId();
      await db.insert(trainingCycles).values({ id: cycleId, trainingBlockId: blockIds[b]!, orderIndex: c, startDate: cycle.start, endDate: cycle.end });
      for (const [w, workout] of order(cycle.workouts)) {
        const id = createEntityId();
        ids[workout.key] = id;
        await db.insert(plannedWorkouts).values({ id, trainingCycleId: cycleId, name: `Workout ${workout.key}`, orderIndex: w, scheduledDate: workout.date, status: "PLANNED" });
      }
    }
  }
  return { programId, versionId, blockIds, ids };
}

/** A real session + the claim an accepted planned START writes (Occurrence Authority V1). */
async function insertCanonicalSession(db: Database, userId: string, plannedWorkoutId: string, status: "ACTIVE" | "COMPLETED"): Promise<void> {
  const sessionId = createEntityId();
  await db.insert(workoutSessions).values({
    id: sessionId,
    userId,
    prescriptionSnapshot: { schemaVersion: 1, prescriptionId: plannedWorkoutId, name: "Session", exercises: [] },
    startedAt: new Date(),
    status,
    completedAt: status === "COMPLETED" ? new Date() : null,
  });
  await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId, plannedWorkoutId, canonicalWorkoutSessionId: sessionId });
}

async function applicationRows(db: Database, athleteProfileId: string) {
  return db.select().from(missedWorkoutScheduleApplications).where(eq(missedWorkoutScheduleApplications.athleteProfileId, athleteProfileId)).orderBy(asc(missedWorkoutScheduleApplications.createdAt), asc(missedWorkoutScheduleApplications.id));
}

async function assignmentRows(db: Database, applicationId: string) {
  return db.select().from(missedWorkoutScheduleAssignments).where(eq(missedWorkoutScheduleAssignments.applicationId, applicationId)).orderBy(asc(missedWorkoutScheduleAssignments.sequencePosition));
}

/** The authored plan graph — must be byte-for-byte unchanged by any apply. */
async function planSnapshot(db: Database, seeded: Seeded) {
  const cycles = await db.select().from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, seeded.blockIds)).orderBy(asc(trainingCycles.id));
  return {
    program: await db.select().from(programs).where(eq(programs.id, seeded.programId)),
    version: await db.select().from(programVersions).where(eq(programVersions.id, seeded.versionId)),
    blocks: await db.select().from(trainingBlocks).where(inArray(trainingBlocks.id, seeded.blockIds)).orderBy(asc(trainingBlocks.id)),
    cycles,
    workouts: await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycles.map((c) => c.id))).orderBy(asc(plannedWorkouts.id)),
  };
}

/** Execution/progression reality — an apply must create none of it. */
async function realitySnapshot(db: Database, athlete: TestAthlete) {
  const jobs = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data::text LIKE ${`%${athlete.userId}%`}`);
  return {
    sessions: await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId)).orderBy(asc(workoutSessions.id)),
    claims: await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, athlete.userId)).orderBy(asc(plannedWorkoutOccurrenceClaims.id)),
    receipts: await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, athlete.userId)),
    decisions: await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, athlete.userId)),
    applications: await db.select().from(progressionApplications).where(eq(progressionApplications.userId, athlete.userId)),
    pgBossJobs: jobs[0]?.n,
  };
}

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, [...userIds]))).map((r) => r.id);
  if (profileIds.length > 0) {
    const applicationIds = (await db.select({ id: missedWorkoutScheduleApplications.id }).from(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.athleteProfileId, profileIds))).map((r) => r.id);
    if (applicationIds.length > 0) {
      await db.delete(missedWorkoutScheduleAssignments).where(inArray(missedWorkoutScheduleAssignments.applicationId, applicationIds));
      await db.update(missedWorkoutScheduleApplications).set({ supersedesApplicationId: null }).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
      await db.delete(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
    }
  }
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, [...userIds]));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, [...userIds]));
  if (profileIds.length > 0) {
    const programIds = (await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, profileIds))).map((r) => r.id);
    const versionIds = programIds.length === 0 ? [] : (await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds))).map((r) => r.id);
    const blockIds = versionIds.length === 0 ? [] : (await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds))).map((r) => r.id);
    const cycleIds = blockIds.length === 0 ? [] : (await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds))).map((r) => r.id);
    if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
    if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
    if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
    if (programIds.length > 0) await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
    await db.delete(programs).where(inArray(programs.athleteProfileId, profileIds));
    await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, profileIds));
  }
  await db.delete(users).where(inArray(users.id, [...userIds]));
}

async function rejection(promise: Promise<unknown>): Promise<Error & { getResponse?: () => unknown }> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (error === undefined) throw new Error("expected a rejection");
  return error as Error & { getResponse?: () => unknown };
}

function rollForward(preview: MissedWorkoutPreviewResponseV1): Extract<MissedWorkoutPreviewResponseV1, { result: "ROLL_FORWARD" }> {
  if (preview.result !== "ROLL_FORWARD") throw new Error(`expected ROLL_FORWARD, got ${preview.result} (${preview.reasonCode})`);
  return preview;
}

describe("Missed Workout apply — effective schedule overlay (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const testUserIds: string[] = [];
  /** Extra, independent connections for the concurrency races — closed after the suite. */
  const extraClients: Database[] = [];
  const freshClient = (): Database => {
    const client = createDatabaseClient(DATABASE_URL);
    extraClients.push(client);
    return client;
  };
  const at = (iso: string) => fixedClock(new Date(iso));
  const previewAt = (iso: string, client: Database = db) => new MissedWorkoutPreviewService(client, at(iso));
  const applyAt = (iso: string, client: Database = db) => new MissedWorkoutApplyService(client, at(iso));
  const planAt = (iso: string) => new PlanReadService(db, at(iso));

  async function athlete(trainingTimeZone: string | null = "Europe/Prague"): Promise<TestAthlete> {
    const created = await createAthlete(db, trainingTimeZone);
    testUserIds.push(created.userId);
    return created;
  }

  async function locked(trainingTimeZone: string | null = "Europe/Prague", blocks: readonly (readonly CycleSeed[])[] = [LOCKED]) {
    const a = await athlete(trainingTimeZone);
    return { a, seeded: await seedProgram(db, a.athleteProfileId, blocks) };
  }

  /** Preview on Wednesday, then apply exactly that preview. */
  async function previewAndApply(a: TestAthlete, iso = WED) {
    const preview = rollForward(await previewAt(iso).preview(a.actor));
    const applied = await applyAt(iso).apply(a.actor, preview.previewFingerprint);
    return { preview, applied };
  }

  afterAll(async () => {
    await cleanup(db, testUserIds);
    await Promise.all(extraClients.map((client) => (client as unknown as { readonly $client: { end(): Promise<void> } }).$client.end()));
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  // --- the locked example -------------------------------------------------------

  it("MWA-001 (1-4, 35): a canonical one-miss preview applies: one ACTIVE application, the complete snapshot, the correct audit", async () => {
    const { a, seeded } = await locked();
    const { ids } = seeded;
    const { preview, applied } = await previewAndApply(a);

    expect(applied).toEqual({
      application: { policyVersion: "missed-workout/v1", previewFingerprint: preview.previewFingerprint, status: "ACTIVE", appliedAt: "2026-10-07T08:00:00.000Z" },
      result: "ROLL_FORWARD",
      missedWorkout: { plannedWorkoutId: ids.A, displayName: "Workout A", scheduledLocalDate: "2026-10-05" },
      effectiveAssignments: [
        { plannedWorkoutId: ids.A, authoredScheduledLocalDate: "2026-10-05", effectiveScheduledLocalDate: "2026-10-07" },
        { plannedWorkoutId: ids.B, authoredScheduledLocalDate: "2026-10-07", effectiveScheduledLocalDate: "2026-10-09" },
        { plannedWorkoutId: ids.C, authoredScheduledLocalDate: "2026-10-09", effectiveScheduledLocalDate: "2026-10-12" },
        { plannedWorkoutId: ids.D, authoredScheduledLocalDate: "2026-10-12", effectiveScheduledLocalDate: null },
      ],
      carryoverWorkoutIds: [ids.D],
    });

    const applications = await applicationRows(db, a.athleteProfileId);
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      athleteProfileId: a.athleteProfileId,
      programVersionId: seeded.versionId,
      trainingBlockId: seeded.blockIds[0],
      policyVersion: "missed-workout/v1",
      previewFingerprint: preview.previewFingerprint,
      athleteLocalDate: "2026-10-07",
      trainingTimeZone: "Europe/Prague",
      missedPlannedWorkoutId: ids.A,
      missedScheduledLocalDate: "2026-10-05",
      originalNextPlannedWorkoutId: ids.B,
      reasonCode: "SINGLE_MISSED_WORKOUT",
      appliedByUserId: a.userId,
      status: "ACTIVE",
      supersedesApplicationId: null,
      supersededAt: null,
    });
    const assignments = await assignmentRows(db, applications[0]!.id);
    expect(assignments.map((r) => [r.sequencePosition, r.plannedWorkoutId, r.assignmentKind, r.authoredScheduledLocalDate, r.effectiveScheduledLocalDate])).toEqual([
      [0, ids.A, "ROLL_FORWARD", "2026-10-05", "2026-10-07"],
      [1, ids.B, "ROLL_FORWARD", "2026-10-07", "2026-10-09"],
      [2, ids.C, "ROLL_FORWARD", "2026-10-09", "2026-10-12"],
      [3, ids.D, "ROLL_FORWARD", "2026-10-12", null],
    ]);
  });

  it("MWA-002 (5-8, 18): the authored plan graph is byte-for-byte unchanged (dates, order, status, cycles, version)", async () => {
    const { a, seeded } = await locked();
    const before = await planSnapshot(db, seeded);
    await previewAndApply(a);
    expect(await planSnapshot(db, seeded)).toEqual(before);
  });

  it("MWA-003 (9-11, 19-20): no session, claim, receipt, progression artifact or pg-boss job is created", async () => {
    const { a } = await locked();
    const before = await realitySnapshot(db, a);
    await previewAndApply(a);
    expect(await realitySnapshot(db, a)).toEqual(before);
  });

  // --- idempotency / concurrency --------------------------------------------------

  it("MWA-004 (12): retrying the same fingerprint returns the same application, even later — never a duplicate", async () => {
    const { a } = await locked();
    const { preview, applied } = await previewAndApply(a);
    expect(await applyAt(WED).apply(a.actor, preview.previewFingerprint)).toEqual(applied);
    expect(await applyAt(THU).apply(a.actor, preview.previewFingerprint)).toEqual(applied);
    const applications = await applicationRows(db, a.athleteProfileId);
    expect(applications).toHaveLength(1);
    expect(await assignmentRows(db, applications[0]!.id)).toHaveLength(4);
  });

  it("MWA-005 (13-14): two concurrent applies of the same fingerprint (separate connections) -> one application, both succeed identically, no duplicate assignments", async () => {
    const { a } = await locked();
    const preview = rollForward(await previewAt(WED).preview(a.actor));
    const first = freshClient();
    const second = freshClient();
    const results = await Promise.all([applyAt(WED, first).apply(a.actor, preview.previewFingerprint), applyAt(WED, second).apply(a.actor, preview.previewFingerprint)]);
    expect(results[0]).toEqual(results[1]);
    const applications = await applicationRows(db, a.athleteProfileId);
    expect(applications).toHaveLength(1);
    expect(applications.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    expect(await assignmentRows(db, applications[0]!.id)).toHaveLength(4);
  });

  it("MWA-006: two concurrent applies of DIFFERENT valid previews (Tue vs Wed) -> exactly one becomes effective, the other is STALE (no overwrite)", async () => {
    const { a } = await locked();
    const wed = rollForward(await previewAt(WED).preview(a.actor));
    // Tuesday's reality: A also missed, same slots, a different local date -> a different valid fingerprint.
    const tue = rollForward(await previewAt(TUE).preview(a.actor));
    expect(wed.previewFingerprint).not.toBe(tue.previewFingerprint);
    const results = await Promise.allSettled([
      applyAt(WED, freshClient()).apply(a.actor, wed.previewFingerprint),
      applyAt(TUE, freshClient()).apply(a.actor, tue.previewFingerprint),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    const applications = await applicationRows(db, a.athleteProfileId);
    expect(applications).toHaveLength(1);
    expect(applications[0]!.status).toBe("ACTIVE");
    expect([wed.previewFingerprint, tue.previewFingerprint]).toContain(applications[0]!.previewFingerprint);
  });

  // --- stale ---------------------------------------------------------------------------

  it.each<[string, (a: TestAthlete, ids: Record<string, string>) => Promise<void>, string]>([
    ["(15) an unknown fingerprint", () => Promise.resolve(), "0".repeat(64)],
    ["(16) a canonical session started after the preview", (a, ids) => insertCanonicalSession(db, a.userId, ids.C!, "ACTIVE"), ""],
    ["(17) a workout status changed after the preview", async (_a, ids) => void (await db.update(plannedWorkouts).set({ status: "SKIPPED" }).where(eq(plannedWorkouts.id, ids.C!))), ""],
    ["(18) the time zone changed after the preview (same calendar day)", async (a) => void (await new MeProjectionService(db).setTrainingTimeZone(a.actor, "Europe/Vienna")), ""],
  ])("MWA-007: %s -> 409 MISSED_WORKOUT_PREVIEW_STALE, nothing written", async (_label, change, forced) => {
    const { a, seeded } = await locked();
    const preview = rollForward(await previewAt(WED).preview(a.actor));
    await change(a, seeded.ids);
    const error = await rejection(applyAt(WED).apply(a.actor, forced === "" ? preview.previewFingerprint : forced));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
  });

  it("MWA-008 (18): the local date changed after the preview (Wed preview applied on Thu) -> STALE, never the newer recommendation", async () => {
    const { a } = await locked();
    const preview = rollForward(await previewAt(WED).preview(a.actor));
    expect((await rejection(applyAt(THU).apply(a.actor, preview.previewFingerprint))).message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
  });

  it("MWA-009: a NO_CHANGE / REVIEW_REQUIRED preview is not applicable (409 + stable reasonCode), nothing written", async () => {
    const { a } = await locked();
    const monday = await previewAt(MON).preview(a.actor);
    const mondayError = await rejection(applyAt(MON).apply(a.actor, monday.previewFingerprint));
    expect(mondayError).toBeInstanceOf(ConflictException);
    expect(mondayError.getResponse?.()).toEqual({ statusCode: 409, message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode: "NO_MISSED_WORKOUT" });
    const saturday = await previewAt(SAT).preview(a.actor);
    expect(saturday.result).toBe("REVIEW_REQUIRED");
    expect((await rejection(applyAt(SAT).apply(a.actor, saturday.previewFingerprint))).getResponse?.()).toEqual({ statusCode: 409, message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode: "MULTIPLE_MISSED_WORKOUTS" });
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
  });

  // --- authorization ----------------------------------------------------------------

  it("MWA-010 (19): athlete A's fingerprint applied by athlete B (identical plan) is just STALE — no leak, nothing written for either", async () => {
    const { a } = await locked();
    const { a: b } = await locked();
    const preview = rollForward(await previewAt(WED).preview(a.actor));
    expect((await rejection(applyAt(WED).apply(b.actor, preview.previewFingerprint))).message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    const noPlan = await athlete();
    expect((await rejection(applyAt(WED).apply(noPlan.actor, preview.previewFingerprint))).message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
    expect(await applicationRows(db, b.athleteProfileId)).toHaveLength(0);
  });

  it("MWA-011 (19): after A applied, B retrying A's fingerprint never receives A's application", async () => {
    const { a } = await locked();
    const { a: b } = await locked();
    const { preview } = await previewAndApply(a);
    expect((await rejection(applyAt(WED).apply(b.actor, preview.previewFingerprint))).message).toBe("MISSED_WORKOUT_PREVIEW_STALE");
    expect(await applicationRows(db, b.athleteProfileId)).toHaveLength(0);
  });

  it("MWA-012 (20): no athlete profile / a mismatched user-profile pair -> 404", async () => {
    const { a } = await locked();
    const b = await athlete();
    const fingerprint = rollForward(await previewAt(WED).preview(a.actor)).previewFingerprint;
    expect(await rejection(applyAt(WED).apply({ userId: createEntityId() }, fingerprint))).toBeInstanceOf(NotFoundException);
    expect(await rejection(applyAt(WED).apply({ userId: b.userId, athleteProfileId: a.athleteProfileId }, fingerprint))).toBeInstanceOf(NotFoundException);
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
  });

  it("MWA-013 (21-22): no training time zone -> 409 TRAINING_TIME_ZONE_REQUIRED; the legacy UTC fallback never reaches an application", async () => {
    const { a } = await locked();
    const preview = rollForward(await previewAt(WED).preview(a.actor));
    await db.update(athleteProfiles).set({ trainingTimeZone: null }).where(eq(athleteProfiles.id, a.athleteProfileId));
    // Ordinary Plan still reads (LEGACY_UTC_FALLBACK), adaptation does not.
    expect((await planAt(WED).readCurrentPlan(a.actor)).scheduleContext?.date.source).toBe("LEGACY_UTC_FALLBACK");
    expect((await rejection(applyAt(WED).apply(a.actor, preview.previewFingerprint))).message).toBe("TRAINING_TIME_ZONE_REQUIRED");
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(0);
  });

  // --- schedule authority -----------------------------------------------------------

  it("MWA-014 (23-26): GAP, AFTER_PLAN, an ambiguous active program and an ambiguous calendar -> 409 CURRENT_TRAINING_BLOCK_UNRESOLVED, nothing written", async () => {
    const twoBlocks: CycleSeed[][] = [[...LOCKED], [{ start: "2026-10-26", end: "2026-11-01", workouts: [{ key: "E", date: "2026-10-26" }] }]];
    const { a } = await locked("Europe/Prague", twoBlocks);
    const fingerprint = rollForward(await previewAt(WED).preview(a.actor)).previewFingerprint;
    for (const instant of ["2026-10-21T08:00:00Z", "2026-11-10T08:00:00Z"]) {
      expect((await rejection(applyAt(instant).apply(a.actor, fingerprint))).message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
    }
    const ambiguousProgram = await locked();
    const ambiguousFingerprint = rollForward(await previewAt(WED).preview(ambiguousProgram.a.actor)).previewFingerprint;
    await seedProgram(db, ambiguousProgram.a.athleteProfileId, [LOCKED]);
    expect((await rejection(applyAt(WED).apply(ambiguousProgram.a.actor, ambiguousFingerprint))).message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
    const overlapping = await locked("Europe/Prague", [[...LOCKED], [{ start: "2026-10-06", end: "2026-10-08", workouts: [] }]]);
    expect((await rejection(applyAt(WED).apply(overlapping.a.actor, "a".repeat(64)))).message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
    for (const profileId of [a.athleteProfileId, ambiguousProgram.a.athleteProfileId, overlapping.a.athleteProfileId]) expect(await applicationRows(db, profileId)).toHaveLength(0);
  });

  // --- effective preview after application ----------------------------------------------

  it("MWA-015 (27-28): after apply, the same day's preview is NO_CHANGE (A is effectively Wednesday) with a different fingerprint", async () => {
    const { a } = await locked();
    const { preview } = await previewAndApply(a);
    const after = await previewAt(WED).preview(a.actor);
    expect(after).toMatchObject({ result: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
    expect(after.previewFingerprint).not.toBe(preview.previewFingerprint);
  });

  it("MWA-016 (28): the next preview feeds EFFECTIVE dates — on Thursday A is missed on its effective Wednesday, never on authored Monday", async () => {
    const { a, seeded } = await locked();
    await previewAndApply(a);
    const thursday = rollForward(await previewAt(THU).preview(a.actor));
    expect(thursday.missedWorkout).toEqual({ plannedWorkoutId: seeded.ids.A, displayName: "Workout A", scheduledLocalDate: "2026-10-07" });
    expect(thursday.nextTrainingSlot).toBe("2026-10-09");
    expect(thursday.upcomingSequence.map((s) => [s.authoredScheduledLocalDate, s.effectiveScheduledLocalDate, s.proposedScheduledLocalDate])).toEqual([
      ["2026-10-05", "2026-10-07", "2026-10-09"],
      ["2026-10-07", "2026-10-09", "2026-10-12"],
      ["2026-10-09", "2026-10-12", null],
      ["2026-10-12", null, null],
    ]);
  });

  // --- Today / Plan --------------------------------------------------------------------

  it("MWA-017 (29-31): Wednesday after apply — Today resolves A (not B); Plan shows A->Wed, B->Fri with authored context; C on next Monday; D carryover", async () => {
    const { a, seeded } = await locked();
    const { ids } = seeded;
    await previewAndApply(a);
    const plan = planAt(WED);
    const overview = await plan.getCurrentPlanOverview(a.actor);
    const today = overview.sessions.find((s) => s.displayStatus === "TODAY");
    expect(today).toMatchObject({ plannedWorkoutId: ids.A, scheduledDate: "2026-10-07", authoredScheduledDate: "2026-10-05", scheduleSource: "ADAPTED" });
    const workoutsInView = overview.sessions.filter((s) => s.plannedWorkoutId !== null).map((s) => [s.plannedWorkoutId, s.scheduledDate, s.authoredScheduledDate, s.scheduleSource, s.displayStatus]);
    expect(workoutsInView).toEqual([
      [ids.A, "2026-10-07", "2026-10-05", "ADAPTED", "TODAY"],
      [ids.B, "2026-10-09", "2026-10-07", "ADAPTED", "PLANNED"],
      // CARRYOVER: still in sequence, no effective date, not skipped/cancelled.
      [ids.D, null, "2026-10-12", "ADAPTED", "PLANNED"],
    ]);
    // Monday 10-05 no longer carries A; Wednesday is A, not B.
    expect(overview.sessions.find((s) => s.scheduledDate === "2026-10-05")?.displayStatus).toBe("REST");
    // Workout Preview agrees: A is TODAY, B is not.
    expect((await plan.getWorkoutPreview(a.actor, ids.A!))?.displayStatus).toBe("TODAY");
    expect((await plan.getWorkoutPreview(a.actor, ids.B!))?.displayStatus).toBe("PLANNED");
    // Next Monday (cycle 1): C is TODAY there (authored Friday of cycle 0); D still carryover.
    const nextMonday = await planAt("2026-10-12T08:00:00Z").getCurrentPlanOverview(a.actor);
    expect(nextMonday.sessions.find((s) => s.displayStatus === "TODAY")).toMatchObject({ plannedWorkoutId: ids.C, authoredScheduledDate: "2026-10-09" });
    expect(nextMonday.sessions.find((s) => s.plannedWorkoutId === ids.D)).toMatchObject({ scheduledDate: null, scheduleSource: "ADAPTED" });
  });

  it("MWA-018 (29): a missed workout from an EARLIER authored cycle still shows as Today in the current cycle (not filtered by authored cycle)", async () => {
    const blocks: CycleSeed[][] = [[
      { start: "2026-09-28", end: "2026-10-04", workouts: [{ key: "W", date: "2026-10-02" }] },
      { start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "Y", date: "2026-10-07" }, { key: "Z", date: "2026-10-09" }] },
    ]];
    const { a, seeded } = await locked("Europe/Prague", blocks);
    const preview = rollForward(await previewAt(MON).preview(a.actor));
    expect(preview.missedWorkout.plannedWorkoutId).toBe(seeded.ids.W);
    await applyAt(MON).apply(a.actor, preview.previewFingerprint);
    const overview = await planAt(WED).getCurrentPlanOverview(a.actor);
    expect(overview.currentBlock?.currentCycleOrder).toBe(1);
    expect(overview.sessions.find((s) => s.displayStatus === "TODAY")).toMatchObject({ plannedWorkoutId: seeded.ids.W, authoredScheduledDate: "2026-10-02", scheduledDate: "2026-10-07" });
  });

  it("MWA-019 (19): the moved workout keeps its identity — Plan and Workout Preview still expose A's own planned workout id / prescription", async () => {
    const { a, seeded } = await locked();
    await previewAndApply(a);
    const preview = await planAt(WED).getWorkoutPreview(a.actor, seeded.ids.A!);
    expect(preview?.plannedWorkoutId).toBe(seeded.ids.A);
    expect(preview?.prescription.prescriptionId).toBe(seeded.ids.A);
    // A later START claims the occurrence of A itself — the overlay never changes claims.
    await insertCanonicalSession(db, a.userId, seeded.ids.A!, "ACTIVE");
    const claims = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId));
    expect(claims.map((c) => c.plannedWorkoutId)).toEqual([seeded.ids.A]);
    expect((await planAt(WED).getCurrentPlanOverview(a.actor)).sessions.find((s) => s.plannedWorkoutId === seeded.ids.A)?.displayStatus).toBe("IN_PROGRESS");
  });

  // --- determinism, isolation, DB constraints -------------------------------------------

  it("MWA-020 (32): reversed DB insertion order yields identical effective assignments", async () => {
    const forward = await locked();
    const reversedAthlete = await athlete();
    const reversed = await seedProgram(db, reversedAthlete.athleteProfileId, [LOCKED], true);
    const f = await previewAndApply(forward.a);
    const r = await previewAndApply(reversedAthlete);
    const byName = (seeded: Seeded, assignments: typeof f.applied.effectiveAssignments) =>
      assignments.map((x) => [Object.entries(seeded.ids).find(([, id]) => id === x.plannedWorkoutId)?.[0], x.authoredScheduledLocalDate, x.effectiveScheduledLocalDate]);
    expect(byName(reversed, r.applied.effectiveAssignments)).toEqual(byName(forward.seeded, f.applied.effectiveAssignments));
  });

  it("MWA-021 (33): repeated reads (Plan, Workout Preview, missed-workout preview) never mutate the overlay", async () => {
    const { a, seeded } = await locked();
    await previewAndApply(a);
    const snapshot = async () => {
      const apps = await applicationRows(db, a.athleteProfileId);
      return { apps, assignments: await Promise.all(apps.map((x) => assignmentRows(db, x.id))) };
    };
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      await planAt(WED).getCurrentPlanOverview(a.actor);
      await planAt(WED).getWorkoutPreview(a.actor, seeded.ids.A!);
      await previewAt(THU).preview(a.actor);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("MWA-022 (34): another athlete's application rows (even pointing at this athlete's block) never affect this athlete's schedule", async () => {
    const { a, seeded } = await locked();
    const b = await athlete();
    const before = await planAt(WED).getCurrentPlanOverview(a.actor);
    const beforePreview = await previewAt(WED).preview(a.actor);
    const foreignId = createEntityId();
    await db.insert(missedWorkoutScheduleApplications).values({
      id: foreignId, athleteProfileId: b.athleteProfileId, programVersionId: seeded.versionId, trainingBlockId: seeded.blockIds[0]!, policyVersion: "missed-workout/v1",
      previewFingerprint: "f".repeat(64), athleteLocalDate: "2026-10-07", trainingTimeZone: "Europe/Prague", missedPlannedWorkoutId: seeded.ids.A!, missedScheduledLocalDate: "2026-10-05",
      originalNextPlannedWorkoutId: null, reasonCode: "SINGLE_MISSED_WORKOUT", appliedByUserId: b.userId, appliedAt: new Date(), status: "ACTIVE", supersedesApplicationId: null, supersededAt: null,
    });
    await db.insert(missedWorkoutScheduleAssignments).values({ id: createEntityId(), applicationId: foreignId, sequencePosition: 0, plannedWorkoutId: seeded.ids.B!, assignmentKind: "ROLL_FORWARD", authoredScheduledLocalDate: "2026-10-07", effectiveScheduledLocalDate: "2026-10-18" });
    expect(await planAt(WED).getCurrentPlanOverview(a.actor)).toEqual(before);
    expect(await previewAt(WED).preview(a.actor)).toEqual(beforePreview);
  });

  it("MWA-023 (36): Postgres itself enforces one ACTIVE overlay per athlete+block and fingerprint uniqueness", async () => {
    const { a, seeded } = await locked();
    const { preview } = await previewAndApply(a);
    const row = (overrides: Partial<typeof missedWorkoutScheduleApplications.$inferInsert>) => ({
      id: createEntityId(), athleteProfileId: a.athleteProfileId, programVersionId: seeded.versionId, trainingBlockId: seeded.blockIds[0]!, policyVersion: "missed-workout/v1",
      previewFingerprint: "b".repeat(64), athleteLocalDate: "2026-10-07", trainingTimeZone: "Europe/Prague", missedPlannedWorkoutId: seeded.ids.A!, missedScheduledLocalDate: "2026-10-05",
      originalNextPlannedWorkoutId: null, reasonCode: "SINGLE_MISSED_WORKOUT", appliedByUserId: a.userId, appliedAt: new Date(), status: "ACTIVE" as const, supersedesApplicationId: null, supersededAt: null,
      ...overrides,
    });
    const describeError = (e: unknown) => `${String(e)} ${String((e as { cause?: unknown }).cause)}`;
    expect(describeError(await rejection(db.insert(missedWorkoutScheduleApplications).values(row({}))))).toContain("missed_workout_schedule_applications_one_active_per_block");
    expect(describeError(await rejection(db.insert(missedWorkoutScheduleApplications).values(row({ previewFingerprint: preview.previewFingerprint, status: "SUPERSEDED", supersededAt: new Date() }))))).toContain("missed_workout_schedule_applications_fingerprint_unique");
    // Postgres truncates identifiers to 63 chars (same as this repo's other long constraint names).
    expect(describeError(await rejection(db.insert(missedWorkoutScheduleApplications).values(row({ status: "SUPERSEDED", supersededAt: null }))))).toContain(
      "missed_workout_schedule_applications_superseded_at_matches_stat",
    );
    expect(await applicationRows(db, a.athleteProfileId)).toHaveLength(1);
  });

  // --- supersession -----------------------------------------------------------------------

  it("MWA-024: a second valid ROLL_FORWARD supersedes atomically, derives from the EFFECTIVE schedule, and keeps history", async () => {
    const { a, seeded } = await locked();
    const { ids } = seeded;
    const first = await previewAndApply(a);
    // A is completed on its effective Wednesday; then B (effective Friday) is missed.
    await insertCanonicalSession(db, a.userId, ids.A!, "COMPLETED");
    const firstRowsBefore = await applicationRows(db, a.athleteProfileId);
    const firstAssignments = await assignmentRows(db, firstRowsBefore[0]!.id);

    const saturday = rollForward(await previewAt(SAT).preview(a.actor));
    expect(saturday.missedWorkout).toEqual({ plannedWorkoutId: ids.B, displayName: "Workout B", scheduledLocalDate: "2026-10-09" });
    expect(saturday.upcomingSequence.map((s) => [s.plannedWorkoutId, s.proposedScheduledLocalDate])).toEqual([[ids.B, "2026-10-12"], [ids.C, null], [ids.D, null]]);
    const second = await applyAt(SAT).apply(a.actor, saturday.previewFingerprint);
    expect(second.effectiveAssignments.map((x) => [x.plannedWorkoutId, x.effectiveScheduledLocalDate])).toEqual([[ids.B, "2026-10-12"], [ids.C, null], [ids.D, null]]);
    expect(second.carryoverWorkoutIds).toEqual([ids.C, ids.D]);

    const rows = await applicationRows(db, a.athleteProfileId);
    expect(rows.map((r) => r.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(rows[0]!.supersededAt?.toISOString()).toBe("2026-10-10T08:00:00.000Z");
    expect(rows[1]!.supersedesApplicationId).toBe(rows[0]!.id);
    // History retained: the first application's snapshot is untouched.
    expect(await assignmentRows(db, rows[0]!.id)).toEqual(firstAssignments);
    // The new ACTIVE snapshot is complete: A's effective Wednesday is RETAINED, not reverted to authored Monday.
    expect((await assignmentRows(db, rows[1]!.id)).map((r) => [r.plannedWorkoutId, r.assignmentKind, r.effectiveScheduledLocalDate])).toEqual([
      [ids.B, "ROLL_FORWARD", "2026-10-12"],
      [ids.C, "ROLL_FORWARD", null],
      [ids.D, "ROLL_FORWARD", null],
      [ids.A, "RETAINED", "2026-10-07"],
    ]);
    // A is never resurrected as missed; nothing else is due.
    expect(await previewAt(SAT).preview(a.actor)).toMatchObject({ result: "NO_CHANGE" });
    const plan = await planAt(SAT).getCurrentPlanOverview(a.actor);
    expect(plan.sessions.find((s) => s.plannedWorkoutId === ids.A)).toMatchObject({ scheduledDate: "2026-10-07", displayStatus: "COMPLETED" });
    // The superseded application is still retrievable idempotently, honestly SUPERSEDED.
    expect((await applyAt(SAT).apply(a.actor, first.preview.previewFingerprint)).application.status).toBe("SUPERSEDED");
    expect(await db.select().from(missedWorkoutScheduleApplications).where(and(eq(missedWorkoutScheduleApplications.athleteProfileId, a.athleteProfileId), eq(missedWorkoutScheduleApplications.status, "ACTIVE")))).toHaveLength(1);
  });
});
