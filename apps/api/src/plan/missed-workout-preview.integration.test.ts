import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  authIdentities,
  createDatabaseClient,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import type { MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { fixedClock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { resolveOrCreateIdentity } from "../auth/identity-resolution.js";
import { MeProjectionService } from "../me/me-projection.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice B, real Postgres — run
 * via `pnpm test:integration`.
 *
 * Locked fixture (Europe/Prague):
 *   cycle 0 (2026-10-05..10-11): Mon 10-05 Upper A, Wed 10-07 Lower A, Fri 10-09 Upper B
 *   cycle 1 (2026-10-12..10-18): Mon 10-12 Lower B
 * Clock frozen at 2026-10-07T08:00Z (Prague 10:00, 2026-10-07):
 *   -> ROLL_FORWARD: missed Upper A, original next Lower A, slot 2026-10-07.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const WEDNESDAY_MORNING = new Date("2026-10-07T08:00:00Z");

type WorkoutStatus = "PLANNED" | "AVAILABLE" | "SKIPPED" | "RESCHEDULED" | "CANCELLED";

interface WorkoutSeed {
  readonly key: string;
  readonly name: string;
  readonly date: string | null;
  readonly status?: WorkoutStatus;
}

interface CycleSeed {
  readonly start: string;
  readonly end: string;
  readonly workouts: readonly WorkoutSeed[];
}

interface ProgramSeed {
  readonly programStatus?: "ACTIVE" | "ARCHIVED";
  readonly versions: readonly { readonly status: "DRAFT" | "ACTIVE" | "SUPERSEDED"; readonly blocks: readonly (readonly CycleSeed[])[] }[];
}

interface TestAthlete {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly actor: AuthenticatedActor;
}

const LOCKED_BLOCK: readonly CycleSeed[] = [
  {
    start: "2026-10-05",
    end: "2026-10-11",
    workouts: [
      { key: "upperA", name: "Upper A", date: "2026-10-05" },
      { key: "lowerA", name: "Lower A", date: "2026-10-07" },
      { key: "upperB", name: "Upper B", date: "2026-10-09" },
    ],
  },
  { start: "2026-10-12", end: "2026-10-18", workouts: [{ key: "lowerB", name: "Lower B", date: "2026-10-12" }] },
];

async function createTestAthlete(db: Database, trainingTimeZone: string | null = "Europe/Prague"): Promise<TestAthlete> {
  const userId = createEntityId();
  await db.insert(users).values({ id: userId, status: "ACTIVE" });
  const athleteProfileId = createEntityId();
  await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC", trainingTimeZone });
  return { userId, athleteProfileId, actor: { userId, athleteProfileId } };
}

/** Seeds programs; returns planned workout ids by key, plus the ACTIVE version / first block ids. */
async function seedPrograms(db: Database, athleteProfileId: string, seeds: readonly ProgramSeed[]): Promise<{ ids: Record<string, string>; activeVersionId?: string; blockIds: string[] }> {
  const ids: Record<string, string> = {};
  const blockIds: string[] = [];
  let activeVersionId: string | undefined;
  for (const programSeed of seeds) {
    const programId = createEntityId();
    await db.insert(programs).values({ id: programId, athleteProfileId, name: "Test Program", status: programSeed.programStatus ?? "ACTIVE" });
    for (const [versionIndex, versionSeed] of programSeed.versions.entries()) {
      const versionId = createEntityId();
      await db.insert(programVersions).values({ id: versionId, programId, versionNumber: versionIndex + 1, status: versionSeed.status, activatedAt: new Date() });
      if (versionSeed.status === "ACTIVE" && (programSeed.programStatus ?? "ACTIVE") === "ACTIVE") activeVersionId = versionId;
      for (const [blockIndex, cycles] of versionSeed.blocks.entries()) {
        const blockId = createEntityId();
        blockIds.push(blockId);
        await db.insert(trainingBlocks).values({ id: blockId, programVersionId: versionId, name: `Block ${blockIndex + 1}`, goal: "Hypertrophy", orderIndex: blockIndex, cycleCount: cycles.length, focusAreas: [] });
        for (const [cycleIndex, cycle] of cycles.entries()) {
          const cycleId = createEntityId();
          await db.insert(trainingCycles).values({ id: cycleId, trainingBlockId: blockId, orderIndex: cycleIndex, startDate: cycle.start, endDate: cycle.end });
          for (const [workoutIndex, workout] of cycle.workouts.entries()) {
            const workoutId = createEntityId();
            ids[workout.key] = workoutId;
            await db.insert(plannedWorkouts).values({ id: workoutId, trainingCycleId: cycleId, name: workout.name, orderIndex: workoutIndex, scheduledDate: workout.date, status: workout.status ?? "PLANNED" });
          }
        }
      }
    }
  }
  return { ids, ...(activeVersionId === undefined ? {} : { activeVersionId }), blockIds };
}

/** A real session; `claim` = what an accepted planned START writes (Occurrence Authority V1). */
async function insertSession(db: Database, userId: string, plannedWorkoutId: string, status: "ACTIVE" | "COMPLETED", claim = true): Promise<void> {
  const sessionId = createEntityId();
  await db.insert(workoutSessions).values({
    id: sessionId,
    userId,
    prescriptionSnapshot: { schemaVersion: 1, prescriptionId: plannedWorkoutId, name: "Session", exercises: [] },
    startedAt: new Date(),
    status,
    completedAt: status === "COMPLETED" ? new Date() : null,
  });
  if (claim) await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId, plannedWorkoutId, canonicalWorkoutSessionId: sessionId }).onConflictDoNothing();
}

/** Every row a preview could conceivably touch, for the "zero mutations" proof. */
async function snapshotState(db: Database, athlete: TestAthlete) {
  const programRows = await db.select().from(programs).where(eq(programs.athleteProfileId, athlete.athleteProfileId)).orderBy(asc(programs.id));
  const versionRows = programRows.length === 0 ? [] : await db.select().from(programVersions).where(inArray(programVersions.programId, programRows.map((r) => r.id))).orderBy(asc(programVersions.id));
  const blockRows = versionRows.length === 0 ? [] : await db.select().from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionRows.map((r) => r.id))).orderBy(asc(trainingBlocks.id));
  const cycleRows = blockRows.length === 0 ? [] : await db.select().from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockRows.map((r) => r.id))).orderBy(asc(trainingCycles.id));
  const workoutRows = cycleRows.length === 0 ? [] : await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleRows.map((r) => r.id))).orderBy(asc(plannedWorkouts.id));
  return {
    profile: await db.select().from(athleteProfiles).where(eq(athleteProfiles.id, athlete.athleteProfileId)),
    programs: programRows,
    versions: versionRows,
    blocks: blockRows,
    cycles: cycleRows,
    workouts: workoutRows,
    sessions: await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId)).orderBy(asc(workoutSessions.id)),
    claims: await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, athlete.userId)).orderBy(asc(plannedWorkoutOccurrenceClaims.id)),
    decisions: await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, athlete.userId)),
    applications: await db.select().from(progressionApplications).where(eq(progressionApplications.userId, athlete.userId)),
  };
}

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, [...userIds]));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, [...userIds]));
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, [...userIds]))).map((r) => r.id);
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
  await db.delete(authIdentities).where(inArray(authIdentities.userId, [...userIds]));
  await db.delete(users).where(inArray(users.id, [...userIds]));
}

function expectRollForward(preview: MissedWorkoutPreviewResponseV1): Extract<MissedWorkoutPreviewResponseV1, { result: "ROLL_FORWARD" }> {
  if (preview.result !== "ROLL_FORWARD") throw new Error(`expected ROLL_FORWARD, got ${preview.result} (${preview.reasonCode})`);
  return preview;
}

async function expectRejection(promise: Promise<unknown>, type: new (...args: never[]) => Error, message: string): Promise<void> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(type);
  expect((error as Error).message).toBe(message);
}

describe("Missed Workout preview — server orchestration (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const testUserIds: string[] = [];
  const serviceAt = (instant: Date = WEDNESDAY_MORNING) => new MissedWorkoutPreviewService(db, fixedClock(instant));

  async function athlete(trainingTimeZone: string | null = "Europe/Prague"): Promise<TestAthlete> {
    const created = await createTestAthlete(db, trainingTimeZone);
    testUserIds.push(created.userId);
    return created;
  }

  async function lockedFixture(block: readonly CycleSeed[] = LOCKED_BLOCK, trainingTimeZone: string | null = "Europe/Prague") {
    const created = await athlete(trainingTimeZone);
    const seeded = await seedPrograms(db, created.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [block] }] }]);
    return { athlete: created, ...seeded };
  }

  /** The locked block with one workout's status overridden. */
  function withStatus(key: string, status: WorkoutStatus): CycleSeed[] {
    return LOCKED_BLOCK.map((cycle) => ({ ...cycle, workouts: cycle.workouts.map((w) => (w.key === key ? { ...w, status } : w)) }));
  }

  afterAll(async () => {
    await cleanup(db, testUserIds);
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  // --- the locked fixture ---------------------------------------------------

  it("MWP-001: the locked fixture -> ROLL_FORWARD: missed Upper A, original next Lower A, slot 2026-10-07", async () => {
    const { athlete: a, ids } = await lockedFixture();
    const preview = expectRollForward(await serviceAt().preview(a.actor));
    expect(preview).toEqual({
      policyVersion: "missed-workout/v1",
      athleteLocalDate: "2026-10-07",
      trainingTimeZone: "Europe/Prague",
      previewFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      result: "ROLL_FORWARD",
      reasonCode: "SINGLE_MISSED_WORKOUT",
      missedWorkout: { plannedWorkoutId: ids.upperA, displayName: "Upper A", scheduledLocalDate: "2026-10-05" },
      recommendedNextWorkout: { plannedWorkoutId: ids.upperA, displayName: "Upper A" },
      originalNextWorkout: { plannedWorkoutId: ids.lowerA, displayName: "Lower A", scheduledLocalDate: "2026-10-07" },
      nextTrainingSlot: "2026-10-07",
      upcomingSequence: [
        { plannedWorkoutId: ids.upperA, displayName: "Upper A", authoredScheduledLocalDate: "2026-10-05", effectiveScheduledLocalDate: "2026-10-05", proposedScheduledLocalDate: "2026-10-07" },
        { plannedWorkoutId: ids.lowerA, displayName: "Lower A", authoredScheduledLocalDate: "2026-10-07", effectiveScheduledLocalDate: "2026-10-07", proposedScheduledLocalDate: "2026-10-09" },
        { plannedWorkoutId: ids.upperB, displayName: "Upper B", authoredScheduledLocalDate: "2026-10-09", effectiveScheduledLocalDate: "2026-10-09", proposedScheduledLocalDate: "2026-10-12" },
        // Carryover: no known training slot, never an invented date.
        { plannedWorkoutId: ids.lowerB, displayName: "Lower B", authoredScheduledLocalDate: "2026-10-12", effectiveScheduledLocalDate: "2026-10-12", proposedScheduledLocalDate: null },
      ],
    });
  });

  it("MWP-002: the sequence spans every cycle of the current block (Lower B lives in cycle 1)", async () => {
    const { athlete: a, ids } = await lockedFixture();
    const preview = expectRollForward(await serviceAt().preview(a.actor));
    expect(preview.upcomingSequence.at(-1)?.plannedWorkoutId).toBe(ids.lowerB);
  });

  it("MWP-003: a workout scheduled today is not missed: on Monday 2026-10-05 -> NO_CHANGE", async () => {
    const { athlete: a } = await lockedFixture();
    expect(await serviceAt(new Date("2026-10-05T08:00:00Z")).preview(a.actor)).toMatchObject({ result: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT", athleteLocalDate: "2026-10-05" });
  });

  // --- time zone / local date -------------------------------------------------

  it("MWP-004: the athlete's local date, not UTC: 2026-10-05T22:30Z is already Tuesday in Prague -> Upper A missed", async () => {
    const { athlete: a, ids } = await lockedFixture();
    const preview = expectRollForward(await serviceAt(new Date("2026-10-05T22:30:00Z")).preview(a.actor));
    expect(preview.athleteLocalDate).toBe("2026-10-06");
    expect(preview.missedWorkout.plannedWorkoutId).toBe(ids.upperA);
    expect(preview.nextTrainingSlot).toBe("2026-10-07");
  });

  it("MWP-005: the same instant in UTC is still Monday — the zone decides", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, "UTC");
    expect(await serviceAt(new Date("2026-10-05T22:30:00Z")).preview(a.actor)).toMatchObject({ result: "NO_CHANGE", athleteLocalDate: "2026-10-05", trainingTimeZone: "UTC" });
  });

  it("MWP-006: America/New_York at 2026-10-07T02:00Z is still Tuesday 10-06", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, "America/New_York");
    const preview = expectRollForward(await serviceAt(new Date("2026-10-07T02:00:00Z")).preview(a.actor));
    expect(preview.athleteLocalDate).toBe("2026-10-06");
    expect(preview.trainingTimeZone).toBe("America/New_York");
  });

  it("MWP-007: no training time zone -> 409 TRAINING_TIME_ZONE_REQUIRED, never a UTC fallback", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, null);
    await expectRejection(serviceAt().preview(a.actor), ConflictException, "TRAINING_TIME_ZONE_REQUIRED");
  });

  it("MWP-008: a stored value that is not an IANA zone (an offset) -> 409 TRAINING_TIME_ZONE_REQUIRED", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, "+02:00");
    await expectRejection(serviceAt().preview(a.actor), ConflictException, "TRAINING_TIME_ZONE_REQUIRED");
  });

  it("MWP-009: a newly provisioned athlete has NO time zone (no UTC backfill) and gets 409", async () => {
    const resolved = await resolveOrCreateIdentity(db, "supabase", `missed-workout-${createEntityId()}`);
    testUserIds.push(resolved.userId);
    const [profile] = await db.select({ trainingTimeZone: athleteProfiles.trainingTimeZone }).from(athleteProfiles).where(eq(athleteProfiles.userId, resolved.userId));
    expect(profile?.trainingTimeZone).toBeNull();
    await expectRejection(serviceAt().preview({ userId: resolved.userId, athleteProfileId: resolved.athleteProfileId }), ConflictException, "TRAINING_TIME_ZONE_REQUIRED");
  });

  it("MWP-010: PUT /me time zone round-trip — canonical IANA id persisted, then used by the preview", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, null);
    const me = new MeProjectionService(db);
    const projection = await me.setTrainingTimeZone(a.actor, "Europe/Prague");
    expect(projection.trainingTimeZone).toBe("Europe/Prague");
    expect((await me.getSafeProjection(a.actor)).trainingTimeZone).toBe("Europe/Prague");
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "ROLL_FORWARD", trainingTimeZone: "Europe/Prague" });
  });

  it("MWP-011: an invalid time zone is rejected with 400 and the stored value is unchanged", async () => {
    const { athlete: a } = await lockedFixture();
    const me = new MeProjectionService(db);
    for (const invalid of ["+02:00", "Mars/Olympus", "", " Europe/Prague"]) {
      await expectRejection(me.setTrainingTimeZone(a.actor, invalid), BadRequestException, "INVALID_TRAINING_TIME_ZONE");
    }
    expect((await me.getSafeProjection(a.actor)).trainingTimeZone).toBe("Europe/Prague");
  });

  it("MWP-012: one athlete's time zone update never touches another athlete's profile", async () => {
    const { athlete: a } = await lockedFixture();
    const b = await athlete("Europe/Prague");
    await new MeProjectionService(db).setTrainingTimeZone({ userId: b.userId, athleteProfileId: a.athleteProfileId }, "Asia/Tokyo");
    expect((await new MeProjectionService(db).getSafeProjection(a.actor)).trainingTimeZone).toBe("Europe/Prague");
  });

  // --- ownership ------------------------------------------------------------------

  it("MWP-013: an actor without an athlete profile -> 404", async () => {
    await expectRejection(serviceAt().preview({ userId: createEntityId() }), NotFoundException, "Athlete profile not found");
  });

  it("MWP-014: BOLA — a mismatched userId/athleteProfileId pair is a 404, never the other athlete's plan", async () => {
    const { athlete: a } = await lockedFixture();
    const b = await athlete();
    await expectRejection(serviceAt().preview({ userId: b.userId, athleteProfileId: a.athleteProfileId }), NotFoundException, "Athlete profile not found");
  });

  it("MWP-015: BOLA — each athlete only ever sees their own occurrences, and another athlete's claim never resolves them", async () => {
    const { athlete: a, ids: aIds } = await lockedFixture();
    const { athlete: b, ids: bIds } = await lockedFixture();
    // B's session claim on B's own Upper A must not affect A.
    await insertSession(db, b.userId, bIds.upperA!, "COMPLETED");
    const previewA = expectRollForward(await serviceAt().preview(a.actor));
    expect(previewA.upcomingSequence.map((s) => s.plannedWorkoutId)).toEqual([aIds.upperA, aIds.lowerA, aIds.upperB, aIds.lowerB]);
    expect(await serviceAt().preview(b.actor)).toMatchObject({ result: "NO_CHANGE" });
  });

  it("MWP-016: an athlete without any plan gets NO_CHANGE, never someone else's plan", async () => {
    await lockedFixture();
    const b = await athlete();
    expect(await serviceAt().preview(b.actor)).toMatchObject({ result: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
  });

  // --- scope: ACTIVE version, current block ------------------------------------------

  it("MWP-017: a SUPERSEDED version's past workouts are never missed occurrences", async () => {
    const a = await athlete();
    const old: CycleSeed[] = [{ start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "oldA", name: "Old A", date: "2026-10-05" }, { key: "oldB", name: "Old B", date: "2026-10-06" }] }];
    const { ids } = await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "SUPERSEDED", blocks: [old] }, { status: "ACTIVE", blocks: [LOCKED_BLOCK] }] }]);
    const preview = expectRollForward(await serviceAt().preview(a.actor));
    expect(preview.missedWorkout.plannedWorkoutId).toBe(ids.upperA);
    expect(preview.upcomingSequence.map((s) => s.plannedWorkoutId)).not.toContain(ids.oldA);
  });

  it("MWP-018: a DRAFT version and an ARCHIVED program never contribute", async () => {
    const a = await athlete();
    const missedEverywhere: CycleSeed[] = [{ start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "x1", name: "X1", date: "2026-10-05" }, { key: "x2", name: "X2", date: "2026-10-06" }] }];
    await seedPrograms(db, a.athleteProfileId, [
      { programStatus: "ARCHIVED", versions: [{ status: "ACTIVE", blocks: [missedEverywhere] }] },
      { versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK] }, { status: "DRAFT", blocks: [missedEverywhere] }] },
    ]);
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "ROLL_FORWARD", reasonCode: "SINGLE_MISSED_WORKOUT" });
  });

  it("MWP-019: a later block of the same version is outside the policy window", async () => {
    const a = await athlete();
    const later: CycleSeed[] = [{ start: "2026-10-19", end: "2026-10-25", workouts: [{ key: "nextBlock", name: "Next Block A", date: "2026-10-19" }] }];
    const { ids } = await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK, later] }] }]);
    const preview = expectRollForward(await serviceAt().preview(a.actor));
    expect(preview.upcomingSequence.map((s) => s.plannedWorkoutId)).not.toContain(ids.nextBlock);
    expect(preview.upcomingSequence).toHaveLength(4);
  });

  it("MWP-020: a previous block's missed workouts are outside the window too", async () => {
    const a = await athlete();
    const earlier: CycleSeed[] = [{ start: "2026-09-28", end: "2026-10-04", workouts: [{ key: "e1", name: "E1", date: "2026-09-28" }, { key: "e2", name: "E2", date: "2026-09-30" }] }];
    await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [earlier, LOCKED_BLOCK] }] }]);
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "ROLL_FORWARD", reasonCode: "SINGLE_MISSED_WORKOUT" });
  });

  it("MWP-021: two ACTIVE programs -> 409 CURRENT_TRAINING_BLOCK_UNRESOLVED (never a guess)", async () => {
    const a = await athlete();
    await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK] }] }, { versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK] }] }]);
    await expectRejection(serviceAt().preview(a.actor), ConflictException, "CURRENT_TRAINING_BLOCK_UNRESOLVED");
  });

  it("MWP-022: two blocks both covering today -> 409 CURRENT_TRAINING_BLOCK_UNRESOLVED", async () => {
    const a = await athlete();
    const overlapping: CycleSeed[] = [{ start: "2026-10-06", end: "2026-10-12", workouts: [{ key: "o", name: "O", date: "2026-10-08" }] }];
    await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK, overlapping] }] }]);
    await expectRejection(serviceAt().preview(a.actor), ConflictException, "CURRENT_TRAINING_BLOCK_UNRESOLVED");
  });

  it("MWP-023: today between blocks or after the plan -> 409; before the plan starts -> NO_CHANGE", async () => {
    const a = await athlete();
    const later: CycleSeed[] = [{ start: "2026-10-26", end: "2026-11-01", workouts: [{ key: "l", name: "L", date: "2026-10-26" }] }];
    await seedPrograms(db, a.athleteProfileId, [{ versions: [{ status: "ACTIVE", blocks: [LOCKED_BLOCK, later] }] }]);
    await expectRejection(serviceAt(new Date("2026-10-21T08:00:00Z")).preview(a.actor), ConflictException, "CURRENT_TRAINING_BLOCK_UNRESOLVED");
    await expectRejection(serviceAt(new Date("2026-11-05T08:00:00Z")).preview(a.actor), ConflictException, "CURRENT_TRAINING_BLOCK_UNRESOLVED");
    expect(await serviceAt(new Date("2026-10-01T08:00:00Z")).preview(a.actor)).toMatchObject({ result: "NO_CHANGE" });
  });

  // --- canonical occurrence state ---------------------------------------------------

  it("MWP-024: a canonical COMPLETED session resolves Upper A -> NO_CHANGE", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.upperA!, "COMPLETED");
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "NO_CHANGE" });
  });

  it("MWP-025: a canonical ACTIVE session also means not missed -> NO_CHANGE", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.upperA!, "ACTIVE");
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "NO_CHANGE" });
  });

  it("MWP-026: an UNCLAIMED session never resolves an occurrence — Upper A is still missed", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.upperA!, "COMPLETED", false);
    expect(expectRollForward(await serviceAt().preview(a.actor)).missedWorkout.plannedWorkoutId).toBe(ids.upperA);
  });

  it("MWP-027: a later canonical COMPLETED session -> REVIEW LATER_SESSION_ALREADY_PERFORMED", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.lowerA!, "COMPLETED");
    expect(await serviceAt(new Date("2026-10-08T08:00:00Z")).preview(a.actor)).toMatchObject({
      result: "REVIEW_REQUIRED",
      reasonCode: "LATER_SESSION_ALREADY_PERFORMED",
      missedWorkoutIds: [ids.upperA],
      performedLaterWorkoutIds: [ids.lowerA],
    });
  });

  it("MWP-028: a later canonical ACTIVE session -> REVIEW LATER_SESSION_ALREADY_PERFORMED", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.lowerA!, "ACTIVE");
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "LATER_SESSION_ALREADY_PERFORMED", performedLaterWorkoutIds: [ids.lowerA] });
  });

  // --- statuses, slots ---------------------------------------------------------------

  it("MWP-029: more than one missed -> REVIEW MULTIPLE_MISSED_WORKOUTS (Saturday 10-10)", async () => {
    const { athlete: a, ids } = await lockedFixture();
    expect(await serviceAt(new Date("2026-10-10T08:00:00Z")).preview(a.actor)).toMatchObject({
      result: "REVIEW_REQUIRED",
      reasonCode: "MULTIPLE_MISSED_WORKOUTS",
      missedWorkoutIds: [ids.upperA, ids.lowerA, ids.upperB],
      performedLaterWorkoutIds: [],
    });
  });

  it.each<WorkoutStatus>(["SKIPPED", "RESCHEDULED", "CANCELLED"])("MWP-030: a %s past workout is resolved and never resurrected -> NO_CHANGE", async (status) => {
    const { athlete: a } = await lockedFixture(withStatus("upperA", status));
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "NO_CHANGE" });
  });

  it("MWP-031: an AVAILABLE past workout is unresolved -> still missed", async () => {
    const { athlete: a, ids } = await lockedFixture(withStatus("upperA", "AVAILABLE"));
    expect(expectRollForward(await serviceAt().preview(a.actor)).missedWorkout.plannedWorkoutId).toBe(ids.upperA);
  });

  it("MWP-032: a resolved later workout is excluded from the upcoming sequence", async () => {
    const { athlete: a, ids } = await lockedFixture(withStatus("upperB", "SKIPPED"));
    expect(expectRollForward(await serviceAt().preview(a.actor)).upcomingSequence.map((s) => s.plannedWorkoutId)).toEqual([ids.upperA, ids.lowerA, ids.lowerB]);
  });

  it("MWP-033: a cancelled-only date is not a slot: the next slot skips it", async () => {
    const block: CycleSeed[] = [
      { start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "a", name: "A", date: "2026-10-05" }, { key: "c", name: "Cancelled", date: "2026-10-08", status: "CANCELLED" }, { key: "b", name: "B", date: "2026-10-10" }] },
    ];
    const { athlete: a } = await lockedFixture(block);
    expect(expectRollForward(await serviceAt().preview(a.actor)).nextTrainingSlot).toBe("2026-10-10");
  });

  it("MWP-034: only cancelled dates ahead -> REVIEW NO_KNOWN_TRAINING_SLOT (no invented availability)", async () => {
    const block: CycleSeed[] = [{ start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "a", name: "A", date: "2026-10-05" }, { key: "c", name: "Cancelled", date: "2026-10-08", status: "CANCELLED" }] }];
    const { athlete: a } = await lockedFixture(block);
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "NO_KNOWN_TRAINING_SLOT" });
  });

  it("MWP-035: the app being opened on a rest day is not a slot — the next authored date is", async () => {
    // Thursday 10-08 has no authored workout: opening the app then is not a training opportunity.
    const block: CycleSeed[] = [{ start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "a", name: "A", date: "2026-10-06" }, { key: "b", name: "B", date: "2026-10-09" }] }];
    const { athlete: a } = await lockedFixture(block);
    expect(expectRollForward(await serviceAt(new Date("2026-10-08T08:00:00Z")).preview(a.actor)).nextTrainingSlot).toBe("2026-10-09");
  });

  it("MWP-036: two workouts on one authored date yield one deduplicated slot", async () => {
    const block: CycleSeed[] = [{ start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "a", name: "A", date: "2026-10-05" }, { key: "b", name: "B AM", date: "2026-10-09" }, { key: "c", name: "C PM", date: "2026-10-09" }] }];
    const { athlete: a, ids } = await lockedFixture(block);
    const preview = expectRollForward(await serviceAt().preview(a.actor));
    expect(preview.nextTrainingSlot).toBe("2026-10-09");
    expect(preview.upcomingSequence.map((s) => s.plannedWorkoutId)).toEqual([ids.a, ids.b, ids.c]);
  });

  it("MWP-037: HARD_DEADLINE through the internal service seam -> REVIEW HARD_TIMELINE_CONSTRAINT; production default is FLEXIBLE", async () => {
    const { athlete: a } = await lockedFixture();
    expect(await serviceAt().preview(a.actor, { timelineConstraint: "HARD_DEADLINE" })).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "HARD_TIMELINE_CONSTRAINT" });
    expect(await serviceAt().preview(a.actor)).toMatchObject({ result: "ROLL_FORWARD" });
  });

  // --- read only -----------------------------------------------------------------------

  it("MWP-038: every outcome (ROLL_FORWARD, REVIEW, NO_CHANGE, 409) performs ZERO mutations", async () => {
    const { athlete: a, ids } = await lockedFixture();
    await insertSession(db, a.userId, ids.lowerB!, "ACTIVE", false); // an unclaimed session that must not be claimed by a preview
    const before = await snapshotState(db, a);
    await serviceAt().preview(a.actor);
    await serviceAt(new Date("2026-10-10T08:00:00Z")).preview(a.actor);
    await serviceAt(new Date("2026-10-05T08:00:00Z")).preview(a.actor);
    await serviceAt(new Date("2026-10-30T08:00:00Z")).preview(a.actor).catch(() => undefined);
    await serviceAt().preview(a.actor, { timelineConstraint: "HARD_DEADLINE" });
    expect(await snapshotState(db, a)).toEqual(before);
  });

  it("MWP-039: a time-zone-required failure is also read only", async () => {
    const { athlete: a } = await lockedFixture(LOCKED_BLOCK, null);
    const before = await snapshotState(db, a);
    await serviceAt().preview(a.actor).catch(() => undefined);
    expect(await snapshotState(db, a)).toEqual(before);
  });

  // --- fingerprint -------------------------------------------------------------------

  it("MWP-040: identical canonical state -> identical preview and fingerprint", async () => {
    const { athlete: a } = await lockedFixture();
    const first = await serviceAt().preview(a.actor);
    const second = await serviceAt(new Date("2026-10-07T20:00:00Z")).preview(a.actor); // same Prague day
    expect(second).toEqual(first);
  });

  it("MWP-041: the fingerprint changes with the local day, the time zone, a status, and a canonical claim", async () => {
    const { athlete: a, ids } = await lockedFixture();
    const base = (await serviceAt().preview(a.actor)).previewFingerprint;
    const fingerprints = new Set([base]);

    fingerprints.add((await serviceAt(new Date("2026-10-08T08:00:00Z")).preview(a.actor)).previewFingerprint);

    await new MeProjectionService(db).setTrainingTimeZone(a.actor, "Europe/Vienna"); // same calendar day, different zone
    fingerprints.add((await serviceAt().preview(a.actor)).previewFingerprint);
    await new MeProjectionService(db).setTrainingTimeZone(a.actor, "Europe/Prague");
    expect((await serviceAt().preview(a.actor)).previewFingerprint).toBe(base);

    await db.update(plannedWorkouts).set({ status: "AVAILABLE" }).where(eq(plannedWorkouts.id, ids.upperB!));
    fingerprints.add((await serviceAt().preview(a.actor)).previewFingerprint);

    await insertSession(db, a.userId, ids.lowerB!, "ACTIVE");
    fingerprints.add((await serviceAt().preview(a.actor)).previewFingerprint);

    expect(fingerprints.size).toBe(5);
  });

  it("MWP-042: a different athlete with an identical plan shape gets a different fingerprint", async () => {
    const { athlete: a } = await lockedFixture();
    const { athlete: b } = await lockedFixture();
    expect((await serviceAt().preview(a.actor)).previewFingerprint).not.toBe((await serviceAt().preview(b.actor)).previewFingerprint);
  });
});
