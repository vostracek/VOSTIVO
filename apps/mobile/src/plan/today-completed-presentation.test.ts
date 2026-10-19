import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlanSessionSummaryV1 } from "@vostivo/contracts";
import { completedTodayView } from "./today-completed-presentation";

const lowerA = { plannedWorkoutId: "w-lower", name: "Lower Body A" } as PlanSessionSummaryV1;

describe("Today — Workout complete presentation (Slice D)", () => {
  it("16/23/24: calm completed hierarchy, View workout -> exact canonical history, Next with the server-relative day", () => {
    expect(completedTodayView({ name: "Upper Body A", workoutSessionId: "sess-canonical" }, { session: lowerA, scheduledDate: "2026-10-15", athleteLocalDate: "2026-10-14" })).toEqual({
      microLabel: "Workout complete",
      title: "Upper Body A",
      body: "Today's training is saved.",
      viewWorkoutLabel: "View workout",
      viewWorkoutHref: "/progress/workouts/sess-canonical",
      next: "Lower Body A · Thu",
      accessibilityLabel: "Workout complete: Upper Body A. Today's training is saved. Next: Lower Body A · Thu.",
    });
  });

  it("25: without a next session the state stays valid and simply omits Next", () => {
    const view = completedTodayView({ name: "Upper Body A", workoutSessionId: "s" }, null);
    expect(view.next).toBeNull();
    expect(view.accessibilityLabel).toBe("Workout complete: Upper Body A. Today's training is saved.");
  });

  it("17: copy never says rest, start, resume, streak or celebrates", () => {
    const view = completedTodayView({ name: "Upper Body A", workoutSessionId: "s" }, { session: lowerA, scheduledDate: "2026-10-20", athleteLocalDate: "2026-10-14" });
    const copy = JSON.stringify(view).toLowerCase();
    for (const forbidden of ["rest day", "start", "resume", "streak", "great job", "congrat", "!"]) expect(copy).not.toContain(forbidden);
  });

  it("17–22: the Today completed hero renders no Start / Resume / Adjust time / Equipment, and the missed-workout card is suppressed", () => {
    const source = readFileSync(new URL("../../app/index.tsx", import.meta.url), "utf8");
    const start = source.indexOf('case "completed-today"');
    const block = source.slice(start, source.indexOf("case ", start + 10));
    expect(start).toBeGreaterThan(-1);
    for (const forbidden of ["Rest day", "Start Workout", "Resume", "onAdjustTime", "onEquipment", "onStartWorkout", "heroCardActive"]) expect(block).not.toContain(forbidden);
    expect(source).toContain('heroState.kind === "completed-today" ? null : missedWorkoutCard(missedState)');
  });
});
