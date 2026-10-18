import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictException } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  trainingBlocks,
  trainingCycles,
  users,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import { fixedClock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { MeProjectionService } from "../me/me-projection.service.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { MissedWorkoutPreviewService } from "../plan/missed-workout-preview.service.js";
import { resolveActiveProgram, resolveAthleteScheduleContext } from "./athlete-schedule-context.js";

/**
 * Schedule Calendar Authority V1 — real Postgres (`pnpm test:integration`).
 * Today and Plan are the same server read (`GET /plan/current`, which the
 * mobile Today hero derives from via server `displayStatus`), plus Workout
 * Preview's `displayStatus`; Missed Workout is the adaptation path. All of
 * them must agree on the athlete-local date, the active program and the
 * current block/cycle classification.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

interface WorkoutSeed {
  readonly key: string;
  readonly date: string;
}
interface CycleSeed {
  readonly start: string;
  readonly end: string;
  readonly workouts?: readonly WorkoutSeed[];
}
interface ProgramSeed {
  readonly status?: "ACTIVE" | "ARCHIVED";
  readonly blocks: readonly (readonly CycleSeed[])[];
  /** Insert cycles (and blocks) in reverse authored order, to prove row order never matters. */
  readonly reverseInsert?: boolean;
}
interface TestAthlete {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly actor: AuthenticatedActor;
}

// Two blocks: B1 = cycles 10-05..10-11 and 10-12..10-18; one-week gap; B2 = 10-26..11-01.
const TWO_BLOCKS: readonly (readonly CycleSeed[])[] = [
  [
    { start: "2026-10-05", end: "2026-10-11", workouts: [{ key: "upperA", date: "2026-10-05" }, { key: "lowerA", date: "2026-10-07" }, { key: "upperB", date: "2026-10-09" }] },
    { start: "2026-10-12", end: "2026-10-18", workouts: [{ key: "lowerB", date: "2026-10-12" }] },
  ],
  [{ start: "2026-10-26", end: "2026-11-01", workouts: [{ key: "nextA", date: "2026-10-26" }] }],
];

async function createAthlete(db: Database, trainingTimeZone: string | null): Promise<TestAthlete> {
  const userId = createEntityId();
  await db.insert(users).values({ id: userId, status: "ACTIVE" });
  const athleteProfileId = createEntityId();
  await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC", trainingTimeZone });
  return { userId, athleteProfileId, actor: { userId, athleteProfileId } };
}

async function seedProgram(db: Database, athleteProfileId: string, seed: ProgramSeed): Promise<{ programId: string; versionId: string; ids: Record<string, string>; cycleIds: string[][] }> {
  const programId = createEntityId();
  await db.insert(programs).values({ id: programId, athleteProfileId, name: "Program", status: seed.status ?? "ACTIVE" });
  const versionId = createEntityId();
  await db.insert(programVersions).values({ id: versionId, programId, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() });
  const ids: Record<string, string> = {};
  const cycleIds: string[][] = seed.blocks.map((cycles) => cycles.map(() => createEntityId()));
  const blockIds = seed.blocks.map(() => createEntityId());
  const blockOrder = seed.blocks.map((_, i) => i);
  for (const b of seed.reverseInsert === true ? [...blockOrder].reverse() : blockOrder) {
    const cycles = seed.blocks[b]!;
    await db.insert(trainingBlocks).values({ id: blockIds[b]!, programVersionId: versionId, name: `Block ${b + 1}`, goal: "Hypertrophy", orderIndex: b, cycleCount: cycles.length, focusAreas: [] });
    const cycleOrder = cycles.map((_, i) => i);
    for (const c of seed.reverseInsert === true ? [...cycleOrder].reverse() : cycleOrder) {
      const cycle = cycles[c]!;
      await db.insert(trainingCycles).values({ id: cycleIds[b]![c]!, trainingBlockId: blockIds[b]!, orderIndex: c, startDate: cycle.start, endDate: cycle.end });
      for (const [w, workout] of (cycle.workouts ?? []).entries()) {
        const id = createEntityId();
        ids[workout.key] = id;
        await db.insert(plannedWorkouts).values({ id, trainingCycleId: cycleIds[b]![c]!, name: workout.key, orderIndex: w, scheduledDate: workout.date, status: "PLANNED" });
      }
    }
  }
  return { programId, versionId, ids, cycleIds };
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
  await db.delete(users).where(inArray(users.id, [...userIds]));
}

async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  return promise.then(() => undefined, (e: unknown) => e as Error);
}

describe("Schedule Calendar Authority V1 (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const testUserIds: string[] = [];
  const planAt = (iso: string) => new PlanReadService(db, fixedClock(new Date(iso)));
  const missedAt = (iso: string) => new MissedWorkoutPreviewService(db, fixedClock(new Date(iso)));

  async function athlete(trainingTimeZone: string | null = "Europe/Prague"): Promise<TestAthlete> {
    const created = await createAthlete(db, trainingTimeZone);
    testUserIds.push(created.userId);
    return created;
  }

  afterAll(async () => {
    await cleanup(db, testUserIds);
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  // --- local midnight ----------------------------------------------------------

  it("SCA-001: 2026-10-06T22:30Z — Prague is already Wednesday: Lower A is TODAY in Plan, Today and Workout Preview", async () => {
    const a = await athlete("Europe/Prague");
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const plan = planAt("2026-10-06T22:30:00Z");
    const read = await plan.readCurrentPlan(a.actor);
    expect(read.scheduleContext?.date).toEqual({ localDate: "2026-10-07", source: "ATHLETE_TIME_ZONE", trainingTimeZone: "Europe/Prague" });
    expect(read.overview.sessions.find((s) => s.displayStatus === "TODAY")?.plannedWorkoutId).toBe(ids.lowerA);
    expect((await plan.getWorkoutPreview(a.actor, ids.lowerA!))?.displayStatus).toBe("TODAY");
  });

  it("SCA-002: the same instant for a NULL-zone athlete is still Tuesday (legacy UTC) — no TODAY workout", async () => {
    const a = await athlete(null);
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const read = await planAt("2026-10-06T22:30:00Z").readCurrentPlan(a.actor);
    expect(read.scheduleContext?.date).toEqual({ localDate: "2026-10-06", source: "LEGACY_UTC_FALLBACK", trainingTimeZone: null });
    expect(read.overview.sessions.some((s) => s.displayStatus === "TODAY")).toBe(false);
    expect((await planAt("2026-10-06T22:30:00Z").getWorkoutPreview(a.actor, ids.lowerA!))?.displayStatus).toBe("PLANNED");
  });

  it("SCA-003: 2026-10-07T02:00Z — New York is still Tuesday (UTC already Wednesday): no TODAY; at 2026-10-07T14:00Z Lower A is TODAY", async () => {
    const a = await athlete("America/New_York");
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const early = await planAt("2026-10-07T02:00:00Z").readCurrentPlan(a.actor);
    expect(early.scheduleContext?.date.localDate).toBe("2026-10-06");
    expect(early.overview.sessions.some((s) => s.displayStatus === "TODAY")).toBe(false);
    const later = await planAt("2026-10-07T14:00:00Z").readCurrentPlan(a.actor);
    expect(later.overview.sessions.find((s) => s.displayStatus === "TODAY")?.plannedWorkoutId).toBe(ids.lowerA);
  });

  it("SCA-004: a cycle boundary at local midnight — Prague is in cycle 1 while UTC and New York are still in cycle 0", async () => {
    const instant = "2026-10-11T22:30:00Z";
    const prague = await athlete("Europe/Prague");
    const utc = await athlete(null);
    const newYork = await athlete("America/New_York");
    for (const a of [prague, utc, newYork]) await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    expect((await planAt(instant).getCurrentPlanOverview(prague.actor)).currentBlock?.currentCycleOrder).toBe(1);
    expect((await planAt(instant).getCurrentPlanOverview(utc.actor)).currentBlock?.currentCycleOrder).toBe(0);
    expect((await planAt(instant).getCurrentPlanOverview(newYork.actor)).currentBlock?.currentCycleOrder).toBe(0);
  });

  it("SCA-005: DST fall-back (2026-10-25) — 23:30Z is Monday 00:30 CET in Prague: the new cycle, still Sunday in UTC", async () => {
    const block: CycleSeed[] = [{ start: "2026-10-19", end: "2026-10-25" }, { start: "2026-10-26", end: "2026-11-01", workouts: [{ key: "mon", date: "2026-10-26" }] }];
    const prague = await athlete("Europe/Prague");
    const utc = await athlete(null);
    for (const a of [prague, utc]) await seedProgram(db, a.athleteProfileId, { blocks: [block] });
    const pragueView = await planAt("2026-10-25T23:30:00Z").getCurrentPlanOverview(prague.actor);
    expect(pragueView.currentBlock?.currentCycleOrder).toBe(1);
    expect(pragueView.sessions.find((s) => s.displayStatus === "TODAY")?.name).toBe("mon");
    expect((await planAt("2026-10-25T23:30:00Z").getCurrentPlanOverview(utc.actor)).currentBlock?.currentCycleOrder).toBe(0);
    // One hour earlier (22:30Z) is still Sunday 23:30 CET in Prague.
    expect((await planAt("2026-10-25T22:30:00Z").getCurrentPlanOverview(prague.actor)).currentBlock?.currentCycleOrder).toBe(0);
  });

  it("SCA-006: DST spring-forward (2026-03-29) — 22:30Z is Monday 00:30 CEST in Prague", async () => {
    const block: CycleSeed[] = [{ start: "2026-03-23", end: "2026-03-29" }, { start: "2026-03-30", end: "2026-04-05", workouts: [{ key: "mon", date: "2026-03-30" }] }];
    const prague = await athlete("Europe/Prague");
    await seedProgram(db, prague.athleteProfileId, { blocks: [block] });
    expect((await planAt("2026-03-29T22:30:00Z").getCurrentPlanOverview(prague.actor)).currentBlock?.currentCycleOrder).toBe(1);
    expect((await planAt("2026-03-29T21:30:00Z").getCurrentPlanOverview(prague.actor)).currentBlock?.currentCycleOrder).toBe(0);
  });

  // --- null time zone compatibility ------------------------------------------------

  it("SCA-007: a NULL-zone athlete still reads Today/Plan (LEGACY_UTC_FALLBACK) but Missed Workout requires a zone", async () => {
    const a = await athlete(null);
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const read = await planAt("2026-10-07T08:00:00Z").readCurrentPlan(a.actor);
    expect(read.scheduleContext?.date.source).toBe("LEGACY_UTC_FALLBACK");
    expect(read.overview.schedule).toEqual({ state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" });
    expect(read.overview.sessions.find((s) => s.displayStatus === "TODAY")?.plannedWorkoutId).toBe(ids.lowerA);
    const error = await rejection(missedAt("2026-10-07T08:00:00Z").preview(a.actor));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error?.message).toBe("TRAINING_TIME_ZONE_REQUIRED");
  });

  it("SCA-008: ordinary reads never write the profile (no automatic UTC persistence)", async () => {
    const a = await athlete(null);
    await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const before = await db.select().from(athleteProfiles).where(inArray(athleteProfiles.id, [a.athleteProfileId]));
    await planAt("2026-10-07T08:00:00Z").getCurrentPlanOverview(a.actor);
    await missedAt("2026-10-07T08:00:00Z").preview(a.actor).catch(() => undefined);
    expect(await db.select().from(athleteProfiles).where(inArray(athleteProfiles.id, [a.athleteProfileId]))).toEqual(before);
  });

  it("SCA-009: once the zone is set, Today/Plan use ATHLETE_TIME_ZONE immediately", async () => {
    const a = await athlete(null);
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const plan = planAt("2026-10-06T22:30:00Z");
    expect((await plan.readCurrentPlan(a.actor)).scheduleContext?.date.source).toBe("LEGACY_UTC_FALLBACK");
    await new MeProjectionService(db).setTrainingTimeZone(a.actor, "Europe/Prague");
    const read = await plan.readCurrentPlan(a.actor);
    expect(read.scheduleContext?.date).toMatchObject({ source: "ATHLETE_TIME_ZONE", localDate: "2026-10-07" });
    expect(read.overview.sessions.find((s) => s.displayStatus === "TODAY")?.plannedWorkoutId).toBe(ids.lowerA);
  });

  // --- active program authority ---------------------------------------------------------

  it("SCA-010: zero ACTIVE programs (only an ARCHIVED one) -> ordinary NO_PLAN state", async () => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { status: "ARCHIVED", blocks: TWO_BLOCKS });
    expect(await planAt("2026-10-07T08:00:00Z").getCurrentPlanOverview(a.actor)).toEqual({ currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null } });
    expect(await resolveActiveProgram(db, a.athleteProfileId)).toEqual({ kind: "NONE" });
  });

  it("SCA-011: exactly one ACTIVE program is selected deterministically, whatever the insertion order of an ARCHIVED one", async () => {
    for (const archivedFirst of [true, false]) {
      const a = await athlete();
      const archived = archivedFirst ? await seedProgram(db, a.athleteProfileId, { status: "ARCHIVED", blocks: TWO_BLOCKS }) : undefined;
      const active = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
      if (!archivedFirst) await seedProgram(db, a.athleteProfileId, { status: "ARCHIVED", blocks: TWO_BLOCKS });
      expect(await resolveActiveProgram(db, a.athleteProfileId)).toEqual({ kind: "ACTIVE", programId: active.programId, programVersionId: active.versionId });
      expect(archived?.programId).not.toBe(active.programId);
    }
  });

  it("SCA-012: the DB allows two ACTIVE programs per athlete (uniqueness is per program, not per athlete) — the authority fails closed", async () => {
    const a = await athlete();
    const first = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const second = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    expect(await resolveActiveProgram(db, a.athleteProfileId)).toEqual({ kind: "AMBIGUOUS", programIds: [first.programId, second.programId].sort() });

    const planError = await rejection(planAt("2026-10-07T08:00:00Z").getCurrentPlanOverview(a.actor));
    expect(planError).toBeInstanceOf(ConflictException);
    expect(planError?.message).toBe("ACTIVE_PROGRAM_AMBIGUOUS");
    expect((await rejection(missedAt("2026-10-07T08:00:00Z").preview(a.actor)))?.message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
  });

  it("SCA-013: …while two ACTIVE versions of ONE program are rejected by the DB itself (program_versions_one_active_per_program)", async () => {
    const a = await athlete();
    const { programId } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const error = await rejection(db.insert(programVersions).values({ id: createEntityId(), programId, versionNumber: 2, status: "ACTIVE", activatedAt: new Date() }));
    expect(error).toBeDefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as { cause?: unknown }).cause)).toContain("program_versions_one_active_per_program");
  });

  // --- block / cycle matrix --------------------------------------------------------------

  it("SCA-014: before the first cycle -> BEFORE_PLAN, the first cycle shown as PRESENTATION_FALLBACK (not an error)", async () => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const overview = await planAt("2026-10-01T08:00:00Z").getCurrentPlanOverview(a.actor);
    expect(overview.schedule).toEqual({ state: "BEFORE_PLAN", displayedCycle: "PRESENTATION_FALLBACK" });
    expect(overview.currentBlock).toMatchObject({ name: "Block 1", currentCycleOrder: 0 });
  });

  it("SCA-015: between blocks -> GAP, the NEXT block's cycle shown as PRESENTATION_FALLBACK", async () => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const overview = await planAt("2026-10-21T08:00:00Z").getCurrentPlanOverview(a.actor);
    expect(overview.schedule).toEqual({ state: "GAP", displayedCycle: "PRESENTATION_FALLBACK" });
    expect(overview.currentBlock).toMatchObject({ name: "Block 2", currentCycleOrder: 0 });
  });

  it("SCA-016: after the final cycle -> AFTER_PLAN (not an error), the LAST block's last cycle shown as PRESENTATION_FALLBACK", async () => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const overview = await planAt("2026-11-10T08:00:00Z").getCurrentPlanOverview(a.actor);
    expect(overview.schedule).toEqual({ state: "AFTER_PLAN", displayedCycle: "PRESENTATION_FALLBACK" });
    expect(overview.currentBlock).toMatchObject({ name: "Block 2", currentCycleOrder: 0 });
  });

  it("SCA-017: inside a cycle -> IN_CURRENT_BLOCK / CURRENT", async () => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const overview = await planAt("2026-10-14T08:00:00Z").getCurrentPlanOverview(a.actor);
    expect(overview.schedule).toEqual({ state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" });
    expect(overview.currentBlock).toMatchObject({ name: "Block 1", currentCycleOrder: 1 });
  });

  it.each([
    ["overlapping cycles of one block", [[{ start: "2026-10-05", end: "2026-10-11" }, { start: "2026-10-08", end: "2026-10-14" }]]],
    ["overlapping blocks", [[{ start: "2026-10-05", end: "2026-10-11" }], [{ start: "2026-10-09", end: "2026-10-15" }]]],
  ] as const)("SCA-018: %s -> Plan 409 CURRENT_SCHEDULE_AMBIGUOUS and Missed Workout 409, never a guess", async (_label, blocks) => {
    const a = await athlete();
    await seedProgram(db, a.athleteProfileId, { blocks });
    expect((await rejection(planAt("2026-10-10T08:00:00Z").getCurrentPlanOverview(a.actor)))?.message).toBe("CURRENT_SCHEDULE_AMBIGUOUS");
    expect((await rejection(missedAt("2026-10-10T08:00:00Z").preview(a.actor)))?.message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
  });

  it("SCA-019: every read path agrees on the date and classification (Plan/Today, Workout Preview, Missed Workout)", async () => {
    const a = await athlete("Europe/Prague");
    const { ids } = await seedProgram(db, a.athleteProfileId, { blocks: TWO_BLOCKS });
    const cases: [string, string][] = [
      ["2026-10-01T08:00:00Z", "BEFORE_PLAN"],
      ["2026-10-04T22:30:00Z", "IN_CURRENT_BLOCK"], // Prague Mon 10-05 00:30, UTC still Sunday
      ["2026-10-07T08:00:00Z", "IN_CURRENT_BLOCK"],
      ["2026-10-21T08:00:00Z", "GAP"],
      ["2026-11-10T08:00:00Z", "AFTER_PLAN"],
    ];
    for (const [instant, state] of cases) {
      const read = await planAt(instant).readCurrentPlan(a.actor);
      const context = await resolveAthleteScheduleContext(db, a.actor, new Date(instant));
      expect(read.overview.schedule.state).toBe(state);
      expect(context?.calendar?.kind).toBe(state);
      expect(read.scheduleContext?.date).toEqual(context?.date);

      const missed = missedAt(instant).preview(a.actor);
      if (state === "IN_CURRENT_BLOCK" || state === "BEFORE_PLAN") {
        expect((await missed).athleteLocalDate).toBe(context?.date.localDate);
      } else {
        expect((await rejection(missed))?.message).toBe("CURRENT_TRAINING_BLOCK_UNRESOLVED");
      }
    }
    // Workout Preview's TODAY uses the same local date as the overview.
    const preview = await planAt("2026-10-04T22:30:00Z").getWorkoutPreview(a.actor, ids.upperA!);
    expect(preview?.displayStatus).toBe("TODAY");
  });

  it("SCA-020: reversed block/cycle insertion order yields identical results", async () => {
    const forward = await athlete();
    const reversed = await athlete();
    await seedProgram(db, forward.athleteProfileId, { blocks: TWO_BLOCKS });
    await seedProgram(db, reversed.athleteProfileId, { blocks: TWO_BLOCKS, reverseInsert: true });
    for (const instant of ["2026-10-01T08:00:00Z", "2026-10-14T08:00:00Z", "2026-10-21T08:00:00Z", "2026-11-10T08:00:00Z"]) {
      const f = await planAt(instant).getCurrentPlanOverview(forward.actor);
      const r = await planAt(instant).getCurrentPlanOverview(reversed.actor);
      const strip = (o: typeof f) => ({ ...o, currentBlock: o.currentBlock && { ...o.currentBlock, trainingBlockId: "x" }, sessions: o.sessions.map((s) => ({ ...s, plannedWorkoutId: s.plannedWorkoutId === null ? null : "x" })) });
      expect(strip(r)).toEqual(strip(f));
    }
  });

  it("SCA-021: no athlete profile -> the safe NO_PLAN state, no schedule context", async () => {
    const read = await planAt("2026-10-07T08:00:00Z").readCurrentPlan({ userId: createEntityId() });
    expect(read.scheduleContext).toBeUndefined();
    expect(read.overview.schedule).toEqual({ state: "NO_PLAN", displayedCycle: null });
  });
});
