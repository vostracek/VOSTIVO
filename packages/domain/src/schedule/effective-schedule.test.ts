import { describe, expect, it } from "vitest";
import { assignRollForwardSlots, resolveEffectiveSchedule } from "./effective-schedule.js";

const AUTHORED = [
  { plannedWorkoutId: "A", authoredScheduledLocalDate: "2026-10-05" },
  { plannedWorkoutId: "B", authoredScheduledLocalDate: "2026-10-07" },
  { plannedWorkoutId: "C", authoredScheduledLocalDate: "2026-10-09" },
  { plannedWorkoutId: "D", authoredScheduledLocalDate: "2026-10-12" },
];

describe("assignRollForwardSlots", () => {
  it("the locked example: Wed->A, Fri->B, Mon->C, D carryover (never an invented date)", () => {
    expect(assignRollForwardSlots(["A", "B", "C", "D"], ["2026-10-07", "2026-10-09", "2026-10-12"])).toEqual([
      { plannedWorkoutId: "A", effectiveScheduledLocalDate: "2026-10-07" },
      { plannedWorkoutId: "B", effectiveScheduledLocalDate: "2026-10-09" },
      { plannedWorkoutId: "C", effectiveScheduledLocalDate: "2026-10-12" },
      { plannedWorkoutId: "D", effectiveScheduledLocalDate: null },
    ]);
  });

  it("slot order/duplicates never matter; no slots -> everything carryover", () => {
    expect(assignRollForwardSlots(["A", "B"], ["2026-10-09", "2026-10-07", "2026-10-09"]).map((a) => a.effectiveScheduledLocalDate)).toEqual(["2026-10-07", "2026-10-09"]);
    expect(assignRollForwardSlots(["A", "B"], []).map((a) => a.effectiveScheduledLocalDate)).toEqual([null, null]);
  });
});

describe("resolveEffectiveSchedule", () => {
  it("without an active application: effective = authored, AUTHORED, no carryover", () => {
    expect(resolveEffectiveSchedule(AUTHORED, null).map((o) => [o.plannedWorkoutId, o.effectiveScheduledLocalDate, o.scheduleSource, o.isCarryover])).toEqual([
      ["A", "2026-10-05", "AUTHORED", false],
      ["B", "2026-10-07", "AUTHORED", false],
      ["C", "2026-10-09", "AUTHORED", false],
      ["D", "2026-10-12", "AUTHORED", false],
    ]);
  });

  it("with an active application: its snapshot wins, authored dates are kept alongside, D is carryover", () => {
    const resolved = resolveEffectiveSchedule(AUTHORED, assignRollForwardSlots(["A", "B", "C", "D"], ["2026-10-07", "2026-10-09", "2026-10-12"]));
    expect(resolved.map((o) => [o.plannedWorkoutId, o.authoredScheduledLocalDate, o.effectiveScheduledLocalDate, o.scheduleSource, o.isCarryover])).toEqual([
      ["A", "2026-10-05", "2026-10-07", "ADAPTED", false],
      ["B", "2026-10-07", "2026-10-09", "ADAPTED", false],
      ["C", "2026-10-09", "2026-10-12", "ADAPTED", false],
      ["D", "2026-10-12", null, "ADAPTED", true],
    ]);
  });

  it("uncovered workouts keep their authored date; an assignment for an unknown workout is ignored", () => {
    const resolved = resolveEffectiveSchedule(AUTHORED, [{ plannedWorkoutId: "C", effectiveScheduledLocalDate: "2026-10-12" }, { plannedWorkoutId: "FOREIGN", effectiveScheduledLocalDate: "2026-10-08" }]);
    expect(resolved.map((o) => o.effectiveScheduledLocalDate)).toEqual(["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-12"]);
    expect(resolved).toHaveLength(4);
  });

  it("assignment row order never matters", () => {
    const assignments = assignRollForwardSlots(["A", "B", "C", "D"], ["2026-10-07", "2026-10-09", "2026-10-12"]);
    expect(resolveEffectiveSchedule(AUTHORED, [...assignments].reverse())).toEqual(resolveEffectiveSchedule(AUTHORED, assignments));
  });
});
