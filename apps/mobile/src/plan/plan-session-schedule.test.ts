import { describe, expect, it } from "vitest";
import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import { planRowAccessibilityLabel, planRowTarget, sessionProgressionNote, sessionScheduleNote } from "./plan-session-schedule";

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
    hasActiveSession: false, hasAppliedProgression: false,
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

describe("sessionProgressionNote (Progress & Feedback Slice C)", () => {
  it("shows the restrained signal only when the server says so — never inferred on the phone", () => {
    expect(sessionProgressionNote({ hasAppliedProgression: true })).toBe("Progression applied");
    expect(sessionProgressionNote({ hasAppliedProgression: false })).toBeNull();
  });
});

describe("Plan row behavior — completed occurrences (Slice D)", () => {
  const completed = session({ plannedWorkoutId: "w-done", name: "Upper Body A", focus: "Push", displayStatus: "COMPLETED", completedWorkoutSessionId: "sess-canonical" });

  it("9: a PLANNED / TODAY row opens Workout Preview", () => {
    expect(planRowTarget(session({ displayStatus: "PLANNED" }))).toEqual({ kind: "PREVIEW", href: "/workout/w-1" });
    expect(planRowTarget(session({ displayStatus: "TODAY" }))).toEqual({ kind: "PREVIEW", href: "/workout/w-1" });
  });

  it("10/11: a COMPLETED row opens the exact canonical workout history — never the ordinary Preview/Start flow", () => {
    expect(planRowTarget(completed)).toEqual({ kind: "HISTORY", href: "/progress/workouts/sess-canonical" });
  });

  it("12: the completed row's spoken label says completed and nothing that sounds startable", () => {
    expect(planRowAccessibilityLabel(completed, null)).toBe("Upper Body A, completed");
    expect(planRowAccessibilityLabel(session({ name: "Upper Body A", focus: "Push" }), "Progression applied")).toBe("Upper Body A, Push, Progression applied");
  });

  it("13: a completed row carries no future progression marker (server sends false; passthrough only)", () => {
    expect(sessionProgressionNote({ ...completed, hasAppliedProgression: false })).toBeNull();
  });

  it("14: rest rows stay untappable", () => {
    expect(planRowTarget(session({ plannedWorkoutId: null, name: "Rest Day", displayStatus: "REST" }))).toEqual({ kind: "NONE" });
  });

  it("15: an IN_PROGRESS row keeps its existing Preview behavior (Start there resolves to the active session)", () => {
    expect(planRowTarget(session({ displayStatus: "IN_PROGRESS", hasActiveSession: true }))).toEqual({ kind: "PREVIEW", href: "/workout/w-1" });
  });

  it("ids are only URL-encoded server values", () => {
    expect(planRowTarget({ ...completed, completedWorkoutSessionId: "a/b" })).toEqual({ kind: "HISTORY", href: "/progress/workouts/a%2Fb" });
  });
});
