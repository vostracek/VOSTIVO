import { describe, expect, it } from "vitest";
import type { PlanCompletedTodayV1, PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { deriveTodayHeroState } from "./today-derivation";
import { adjustableTodaySession } from "../available-time/available-time-flow";

function buildSession(overrides: Partial<PlanSessionSummaryV1> = {}): PlanSessionSummaryV1 {
  return {
    plannedWorkoutId: "workout-1",
    name: "Upper Body A",
    focus: "Push emphasis",
    order: 1,
    scheduledDate: "2026-09-24",
    authoredScheduledDate: "2026-09-24",
    scheduleSource: "AUTHORED",
    estimatedDurationMinutes: 60,
    displayStatus: "PLANNED",
    hasActiveSession: false, hasAppliedProgression: false,
    ...overrides,
  };
}

const NO_PLAN_OVERVIEW: PlanOverviewV1 = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null }, athleteLocalDate: null };
const BLOCK = { trainingBlockId: "b1", name: "Block 1", goal: "Hypertrophy", currentCycleOrder: 2, cycleCount: 6, daysPerWeek: 4 };

describe("deriveTodayHeroState", () => {
  it("TODAY-MOB-001: no active session, overview still loading -> loading", () => {
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "loading" } });
    expect(result).toEqual({ kind: "loading" });
  });

  it("TODAY-MOB-002: no active session, overview fetch failed -> error with the message", () => {
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "error", message: "network down" } });
    expect(result).toEqual({ kind: "error", message: "network down" });
  });

  it("TODAY-MOB-003: an active session anywhere always wins, even while the overview is still loading", () => {
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: true, overview: { status: "loading" } });
    expect(result).toEqual({ kind: "resume" });
  });

  it("TODAY-MOB-004: an active session anywhere wins even over a ready, error-free overview", () => {
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [buildSession({ displayStatus: "TODAY" })], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: true, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "resume" });
  });

  it("TODAY-MOB-005: ready overview with no current program -> no-plan", () => {
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: NO_PLAN_OVERVIEW } });
    expect(result).toEqual({ kind: "no-plan" });
  });

  it("TODAY-MOB-006: a session with displayStatus TODAY -> training-day with that exact session", () => {
    const todaySession = buildSession({ plannedWorkoutId: "workout-today", name: "Lower Body B", displayStatus: "TODAY" });
    const overview: PlanOverviewV1 = {
      currentBlock: BLOCK,
      sessions: [buildSession({ plannedWorkoutId: "workout-past", displayStatus: "COMPLETED" }), todaySession, buildSession({ plannedWorkoutId: "workout-future", displayStatus: "PLANNED" })],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "training-day", session: todaySession });
  });

  it("TODAY-MOB-007: no TODAY session but a later PLANNED session exists -> rest with that as nextWorkout", () => {
    const nextWorkout = buildSession({ plannedWorkoutId: "workout-next", name: "Lower Body B", displayStatus: "PLANNED" });
    const overview: PlanOverviewV1 = {
      currentBlock: BLOCK,
      sessions: [buildSession({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST" }), nextWorkout],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout });
  });

  it("TODAY-MOB-008: no TODAY session and no PLANNED session either -> rest with nextWorkout null", () => {
    const overview: PlanOverviewV1 = {
      currentBlock: BLOCK,
      sessions: [buildSession({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST" }), buildSession({ displayStatus: "COMPLETED" })],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout: null });
  });

  it("TODAY-MOB-009: a gap between blocks (no entry at all matches TODAY, none is even REST) still reads as rest, never an empty/broken state", () => {
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [buildSession({ displayStatus: "COMPLETED" }), buildSession({ displayStatus: "SKIPPED" })], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result.kind).toBe("rest");
  });

  it("TODAY-MOB-010: an empty sessions array with an active program still resolves safely (no-plan is reserved for currentBlock === null only)", () => {
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout: null });
  });
});

describe("deriveTodayHeroState — completed today (Progress & Feedback V1 Slice D)", () => {
  // Wednesday 2026-10-14 is the server's athlete-local today.
  const TODAY = "2026-10-14";
  const FACT: PlanCompletedTodayV1 = { plannedWorkoutId: "w-upper", workoutSessionId: "sess-canonical", workoutName: "Upper Body A", completedLocalDate: TODAY };
  const doneRow = buildSession({ plannedWorkoutId: "w-upper", name: "Upper Body A", scheduledDate: TODAY, displayStatus: "COMPLETED", completedWorkoutSessionId: "sess-canonical" });
  const lowerThu = buildSession({ plannedWorkoutId: "w-lower", name: "Lower Body A", scheduledDate: "2026-10-15", displayStatus: "PLANNED" });
  const rest = buildSession({ plannedWorkoutId: null, name: "Rest Day", scheduledDate: "2026-10-16", displayStatus: "REST" });
  const derive = (sessions: PlanSessionSummaryV1[], options: { completedToday?: PlanCompletedTodayV1; hasActive?: boolean; athleteLocalDate?: string | null } = {}) =>
    deriveTodayHeroState({
      hasActiveSessionAnywhere: options.hasActive ?? false,
      overview: {
        status: "ready",
        overview: {
          currentBlock: BLOCK,
          sessions,
          weeklyFocus: [],
          schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" },
          athleteLocalDate: options.athleteLocalDate === undefined ? TODAY : options.athleteLocalDate,
          ...(options.completedToday === undefined ? {} : { completedToday: options.completedToday }),
        },
      },
    });

  it("13/17: server completedToday + no training-day -> completed-today with the exact canonical id and the next effective session", () => {
    expect(derive([doneRow, lowerThu, rest], { completedToday: FACT })).toEqual({
      kind: "completed-today",
      completed: { name: "Upper Body A", workoutSessionId: "sess-canonical" },
      nextWorkout: { session: lowerThu, scheduledDate: "2026-10-15", athleteLocalDate: TODAY },
    });
  });

  it("12: consumes the server fact even when the completed occurrence is NOT in overview.sessions (previous cycle / rolled forward)", () => {
    const previousCycle: PlanCompletedTodayV1 = { plannedWorkoutId: "w-cycle1-upper-b", workoutSessionId: "sess-cycle1", workoutName: "Upper Body B", completedLocalDate: TODAY };
    expect(derive([rest, lowerThu], { completedToday: previousCycle })).toMatchObject({ kind: "completed-today", completed: { name: "Upper Body B", workoutSessionId: "sess-cycle1" } });
    expect(derive([], { completedToday: previousCycle })).toMatchObject({ kind: "completed-today", nextWorkout: null });
  });

  it("16: no server fact -> existing rest behavior, even with a COMPLETED row in sessions (never reconstructed from rows)", () => {
    expect(derive([doneRow, lowerThu])).toEqual({ kind: "rest", nextWorkout: lowerThu });
  });

  it("18: never a startable/resumable/adjustable session (Adjust time & Equipment key off training-day only)", () => {
    const hero = derive([doneRow, lowerThu], { completedToday: FACT });
    expect(hero.kind).toBe("completed-today");
    expect(hero).not.toHaveProperty("session");
    expect(adjustableTodaySession(hero)).toBeNull();
  });

  it("14: an active session still wins (Resume)", () => {
    expect(derive([doneRow, lowerThu], { completedToday: FACT, hasActive: true })).toEqual({ kind: "resume" });
  });

  it("15: a legitimate open TODAY workout still keeps the primary job after another one was completed today", () => {
    const todayOpen = buildSession({ plannedWorkoutId: "w-today", scheduledDate: TODAY, displayStatus: "TODAY" });
    expect(derive([todayOpen], { completedToday: { ...FACT, plannedWorkoutId: "w-cycle1" } })).toEqual({ kind: "training-day", session: todayOpen });
  });

  it("no trustworthy next session -> completed state without Next (past missed / carryover never 'next')", () => {
    const missedMon = buildSession({ plannedWorkoutId: "w-mon", scheduledDate: "2026-10-12", displayStatus: "PLANNED" });
    const carryover = buildSession({ plannedWorkoutId: "w-carry", scheduledDate: null, scheduleSource: "ADAPTED", displayStatus: "PLANNED" });
    expect(derive([missedMon, doneRow, carryover], { completedToday: FACT })).toMatchObject({ kind: "completed-today", nextWorkout: null });
  });

  it("a fact for another day than the server's today, or no server date at all -> never completed-today (no device-date fallback)", () => {
    expect(derive([doneRow], { completedToday: { ...FACT, completedLocalDate: "2026-10-13" } }).kind).toBe("rest");
    expect(derive([doneRow], { completedToday: FACT, athleteLocalDate: null }).kind).toBe("rest");
  });
});
