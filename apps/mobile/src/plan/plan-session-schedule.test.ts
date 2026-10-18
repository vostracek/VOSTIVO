import { describe, expect, it } from "vitest";
import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import { sessionScheduleNote } from "./plan-session-schedule";

function session(overrides: Partial<PlanSessionSummaryV1>): PlanSessionSummaryV1 {
  return {
    plannedWorkoutId: "w-1",
    name: "Upper A",
    focus: null,
    order: 0,
    scheduledDate: "2026-10-05",
    authoredScheduledDate: "2026-10-05",
    scheduleSource: "AUTHORED",
    estimatedDurationMinutes: 60,
    displayStatus: "PLANNED",
    hasActiveSession: false,
    ...overrides,
  };
}

describe("Plan session schedule presentation (effective schedule)", () => {
  it("32: a normal authored workout stays visually clean (no Authored/Adjusted label)", () => {
    expect(sessionScheduleNote(session({}))).toEqual({ kind: "NONE" });
  });

  it("27/28/29: an adapted workout sits on its effective date with a subtle Adjusted tag and the authored day only as secondary context", () => {
    expect(sessionScheduleNote(session({ scheduledDate: "2026-10-07", authoredScheduledDate: "2026-10-05", scheduleSource: "ADAPTED", displayStatus: "TODAY" }))).toEqual({
      kind: "ADJUSTED",
      tag: "Adjusted",
      originally: "Originally Monday",
    });
  });

  it("30/31: a carryover stays visible as 'Needs a training day' — never Skipped/Cancelled/Missed, never a fake date", () => {
    const note = sessionScheduleNote(session({ scheduledDate: null, authoredScheduledDate: "2026-10-12", scheduleSource: "ADAPTED", displayStatus: "PLANNED" }));
    expect(note).toEqual({ kind: "NEEDS_TRAINING_DAY", label: "Needs a training day" });
    expect(JSON.stringify(note)).not.toMatch(/Skipped|Cancelled|Missed|\d{4}-\d{2}-\d{2}/);
  });

  it("rest days and authored-unscheduled workouts get no note", () => {
    expect(sessionScheduleNote(session({ plannedWorkoutId: null, displayStatus: "REST" }))).toEqual({ kind: "NONE" });
    expect(sessionScheduleNote(session({ scheduledDate: null, authoredScheduledDate: null }))).toEqual({ kind: "NONE" });
  });
});
