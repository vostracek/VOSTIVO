import { describe, expect, it } from "vitest";
import type { PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { blockMetaLine, blockWeekLabel, planStatusLabel, sessionWeekday, todayMetaParts, weekStrip } from "./week-presentation";

function session(overrides: Partial<PlanSessionSummaryV1>): PlanSessionSummaryV1 {
  return {
    plannedWorkoutId: "pw-1",
    name: "Upper A",
    focus: "Chest + Back",
    order: 1,
    scheduledDate: "2026-11-16",
    authoredScheduledDate: "2026-11-16",
    scheduleSource: "AUTHORED",
    estimatedDurationMinutes: 58,
    displayStatus: "PLANNED",
    hasActiveSession: false,
    hasAppliedProgression: false,
    ...overrides,
  };
}

function overview(sessions: PlanSessionSummaryV1[], displayedCycle: "CURRENT" | "PRESENTATION_FALLBACK" | null = "CURRENT"): Pick<PlanOverviewV1, "sessions" | "schedule"> {
  return { sessions, schedule: { state: "IN_CURRENT_BLOCK", displayedCycle } };
}

describe("week presentation (Design Integration 01)", () => {
  it("DI-WEEK-001: block labels come from the real cycle position and days per week", () => {
    expect(blockWeekLabel({ currentCycleOrder: 4, cycleCount: 6 })).toBe("Week 4 / 6");
    expect(blockMetaLine({ currentCycleOrder: 4, cycleCount: 6, daysPerWeek: 4 })).toBe("Week 4 / 6 · 4 days / week");
    expect(blockMetaLine({ currentCycleOrder: 1, cycleCount: 1, daysPerWeek: 1 })).toBe("Week 1 / 1 · 1 day / week");
  });

  it("DI-WEEK-002: weekday from the server's local date (no device clock), null without a date", () => {
    expect(sessionWeekday({ scheduledDate: "2026-11-19" })).toBe("Thu");
    expect(sessionWeekday({ scheduledDate: null })).toBeNull();
  });

  it("DI-WEEK-003: the strip lists training sessions only, counts completed ones, lime only for today", () => {
    const strip = weekStrip(
      overview([
        session({ plannedWorkoutId: "a", scheduledDate: "2026-11-16", displayStatus: "COMPLETED" }),
        session({ plannedWorkoutId: null, name: "Rest", scheduledDate: "2026-11-17", displayStatus: "REST" }),
        session({ plannedWorkoutId: "b", scheduledDate: "2026-11-19", displayStatus: "TODAY" }),
        session({ plannedWorkoutId: "c", scheduledDate: "2026-11-21", displayStatus: "PLANNED" }),
      ]),
    );
    expect(strip?.summary).toBe("1 of 3 sessions");
    expect(strip?.days.map((day) => [day.day, day.tone, day.statusLabel])).toEqual([
      ["Mon", "done", "Done"],
      ["Thu", "today", "Today"],
      ["Sat", "planned", "Planned"],
    ]);
  });

  it("DI-WEEK-004: never claims a week that is not the current one, and hides without training sessions", () => {
    expect(weekStrip(overview([session({})], "PRESENTATION_FALLBACK"))).toBeNull();
    expect(weekStrip(overview([session({ plannedWorkoutId: null, displayStatus: "REST" })]))).toBeNull();
  });

  it("DI-WEEK-005: hero meta shows only known facts — no invented duration or count", () => {
    expect(todayMetaParts({ focus: "Chest + Back", estimatedDurationMinutes: 58 }, 5)).toEqual({ focus: "Chest + Back", details: ["5 exercises", "~58 min"] });
    expect(todayMetaParts({ focus: null, estimatedDurationMinutes: null }, null)).toEqual({ focus: null, details: [] });
    expect(todayMetaParts({ focus: null, estimatedDurationMinutes: null }, 1).details).toEqual(["1 exercise"]);
  });

  it("DI-WEEK-006: every status carries a word", () => {
    for (const status of ["COMPLETED", "IN_PROGRESS", "TODAY", "PLANNED", "SKIPPED", "RESCHEDULED", "CANCELLED", "REST"] as const) {
      expect(planStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});
