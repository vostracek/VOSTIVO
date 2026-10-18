import { describe, expect, it } from "vitest";
import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import type { AvailableTimeApplicationV1 } from "@vostivo/domain";
import { deriveTodayHeroState } from "../plan/today-derivation";
import {
  INITIAL_FLOW_STATE,
  QUICK_TIME_CHOICES_MINUTES,
  adjustableTodaySession,
  adjustedSessionLabel,
  changeRowDetail,
  changeRows,
  estimatedMinutes,
  submittableMinutes,
  validateCustomMinutes,
} from "./available-time-flow";
import { adjustPreview, adjustPreviewOhpOnly, WORKOUT_ID } from "./testing/fixtures";

function todaySession(overrides: Partial<PlanSessionSummaryV1> = {}): PlanSessionSummaryV1 {
  return { plannedWorkoutId: WORKOUT_ID, name: "Upper Body A", focus: "Push emphasis", order: 1, scheduledDate: "2026-10-05", authoredScheduledDate: "2026-10-05", scheduleSource: "AUTHORED", estimatedDurationMinutes: 60, displayStatus: "TODAY", hasActiveSession: false, ...overrides };
}

function hero(hasActiveSessionAnywhere: boolean, session = todaySession()) {
  return deriveTodayHeroState({
    hasActiveSessionAnywhere,
    overview: { status: "ready", overview: { currentBlock: { trainingBlockId: "b", name: "Block", goal: "Hypertrophy", currentCycleOrder: 1, cycleCount: 4, daysPerWeek: 3 }, sessions: [session], weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" } } },
  });
}

describe("Today entry — Adjust time", () => {
  it("1: an eligible TODAY planned workout offers Adjust time", () => {
    expect(adjustableTodaySession(hero(false))?.plannedWorkoutId).toBe(WORKOUT_ID);
  });

  it("2: a local active/resumable workout wins — no competing Adjust time", () => {
    expect(hero(true).kind).toBe("resume");
    expect(adjustableTodaySession(hero(true))).toBeNull();
  });

  it("is not offered for an occurrence the server already reports started, or a non-planned session", () => {
    expect(adjustableTodaySession(hero(false, todaySession({ hasActiveSession: true })))).toBeNull();
    expect(adjustableTodaySession(hero(false, todaySession({ plannedWorkoutId: null })))).toBeNull();
    expect(adjustableTodaySession({ kind: "rest" })).toBeNull();
  });
});

describe("time selection", () => {
  it("3/4: the sheet opens with NO time selected and nothing submittable", () => {
    expect(INITIAL_FLOW_STATE).toEqual({ kind: "SELECT_TIME", selection: { kind: "none" } });
    expect(submittableMinutes({ kind: "none" })).toBeNull();
  });

  it("5: the quick choices are exactly 30/45/60/75 and each submits itself", () => {
    expect(QUICK_TIME_CHOICES_MINUTES).toEqual([30, 45, 60, 75]);
    for (const minutes of QUICK_TIME_CHOICES_MINUTES) expect(submittableMinutes({ kind: "preset", minutes })).toBe(minutes);
  });

  it.each([["1", 1], ["35", 35], ["240", 240], ["007", 7]])("7: Custom %s is valid", (text, minutes) => {
    expect(validateCustomMinutes(text)).toEqual({ status: "valid", minutes });
    expect(submittableMinutes({ kind: "custom", text })).toBe(minutes);
  });

  it.each([["0"], ["241"], ["999"], ["-5"], ["12.5"], ["12,5"], ["abc"], [" 30"], ["1e2"]])("8/9/10: Custom %j is rejected (never clamped or rounded)", (text) => {
    expect(validateCustomMinutes(text)).toEqual({ status: "invalid", message: "Enter whole minutes from 1 to 240." });
    expect(submittableMinutes({ kind: "custom", text })).toBeNull();
  });

  it("11: empty Custom is not submittable, with no error shown", () => {
    expect(validateCustomMinutes("")).toEqual({ status: "empty" });
    expect(submittableMinutes({ kind: "custom", text: "" })).toBeNull();
  });
});

describe("preview presentation", () => {
  it("14: estimates round partial minutes UP (never understated)", () => {
    expect(estimatedMinutes(540)).toBe(9);
    expect(estimatedMinutes(2000)).toBe(34); // 33m 20s -> ~34 min
    expect(estimatedMinutes(1)).toBe(1);
  });

  it("15/16/17: only changed exercises — reduced as `N → M sets`, removed as `Removed today`", () => {
    const rows = changeRows(adjustPreview());
    expect(rows.map((row) => [row.displayName, changeRowDetail(row)])).toEqual([
      ["Bench Press", "3 → 2 sets"],
      ["Overhead Press", "Removed today"],
    ]);
  });

  it("15: an unchanged exercise is hidden", () => {
    expect(changeRows(adjustPreviewOhpOnly()).map((row) => [row.displayName, changeRowDetail(row)])).toEqual([["Overhead Press", "2 → 1 sets"]]);
  });

  it("18: rendered rows carry no tiers, minimums, set ids, fingerprint or policy", () => {
    const rendered = changeRows(adjustPreview())
      .map((row) => `${row.displayName} ${changeRowDetail(row)}`)
      .join(" | ");
    for (const internal of ["TIER", "minimum", "available-time/v1", "fffffff", "00000000-"]) expect(rendered).not.toContain(internal);
  });
});

describe("Active Workout sublabel", () => {
  it("31: an adjusted session shows `Adjusted · X min` from its local metadata", () => {
    const application = { availableMinutes: 35 } as AvailableTimeApplicationV1;
    expect(adjustedSessionLabel({ availableTimeApplication: application })).toBe("Adjusted · 35 min");
  });

  it("32: an ordinary session has no label at all (nothing rendered, no gap)", () => {
    expect(adjustedSessionLabel({ availableTimeApplication: null })).toBeNull();
  });
});
