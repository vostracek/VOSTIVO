import { describe, expect, it } from "vitest";
import type { PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { deriveTodayHeroState } from "./today-derivation";

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
    hasActiveSession: false,
    ...overrides,
  };
}

const NO_PLAN_OVERVIEW: PlanOverviewV1 = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null } };
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
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [buildSession({ displayStatus: "TODAY" })], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" } };
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
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" },
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "training-day", session: todaySession });
  });

  it("TODAY-MOB-007: no TODAY session but a later PLANNED session exists -> rest with that as nextWorkout", () => {
    const nextWorkout = buildSession({ plannedWorkoutId: "workout-next", name: "Lower Body B", displayStatus: "PLANNED" });
    const overview: PlanOverviewV1 = {
      currentBlock: BLOCK,
      sessions: [buildSession({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST" }), nextWorkout],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" },
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout });
  });

  it("TODAY-MOB-008: no TODAY session and no PLANNED session either -> rest with nextWorkout null", () => {
    const overview: PlanOverviewV1 = {
      currentBlock: BLOCK,
      sessions: [buildSession({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST" }), buildSession({ displayStatus: "COMPLETED" })],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" },
    };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout: null });
  });

  it("TODAY-MOB-009: a gap between blocks (no entry at all matches TODAY, none is even REST) still reads as rest, never an empty/broken state", () => {
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [buildSession({ displayStatus: "COMPLETED" }), buildSession({ displayStatus: "SKIPPED" })], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" } };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result.kind).toBe("rest");
  });

  it("TODAY-MOB-010: an empty sessions array with an active program still resolves safely (no-plan is reserved for currentBlock === null only)", () => {
    const overview: PlanOverviewV1 = { currentBlock: BLOCK, sessions: [], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" } };
    const result = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview } });
    expect(result).toEqual({ kind: "rest", nextWorkout: null });
  });
});
