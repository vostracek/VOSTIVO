import { describe, expect, it } from "vitest";
import { COPY, longDayLabel, missedWorkoutCard, reviewRequiredReason, reviewSummary, scheduleChanges, shortDayLabel } from "./missed-workout-flow";
import { IDS, rollForwardPreview } from "./testing/fixtures";

describe("missed workout flow — pure presentation rules", () => {
  it("1: NO_CHANGE / idle / dismissed / a failed preview -> no card at all", () => {
    expect(missedWorkoutCard({ kind: "IDLE" })).toBeNull();
    expect(missedWorkoutCard({ kind: "DISMISSED" })).toBeNull();
    expect(missedWorkoutCard({ kind: "PREVIEW_ERROR" })).toBeNull();
  });

  it("2/3: ROLL_FORWARD -> a calm recommendation naming the missed workout from server data (no guilt/streak/alarm words)", () => {
    const card = missedWorkoutCard({ kind: "ROLL_FORWARD", preview: rollForwardPreview(), reviewOpen: false, apply: { status: "idle" }, planChanged: false });
    expect(card).toEqual({ kind: "RECOMMENDATION", title: "You missed Upper A", body: "Keep your training sequence intact by doing Upper A next." });
    expect(JSON.stringify(card)).not.toMatch(/\b(fail|failed|streak|broke|error|warning|AI)\b/i);
  });

  it("5: the review summary: missed Upper A on Monday, recommended next Upper A today", () => {
    expect(reviewSummary(rollForwardPreview())).toEqual({ missedName: "Upper A", missedDayLabel: "Monday", recommendedName: "Upper A", recommendedDayLabel: "Today" });
  });

  it("6/7/8: changes-only diff: Today<-Mon, Fri<-Wed, Mon<-Fri; Lower B needs a training day with NO date", () => {
    const changes = scheduleChanges(rollForwardPreview());
    expect(changes.moves).toEqual([
      { plannedWorkoutId: IDS.upperA, displayName: "Upper A", toLabel: "Today", fromLabel: "Mon" },
      { plannedWorkoutId: IDS.lowerA, displayName: "Lower A", toLabel: "Fri", fromLabel: "Today" },
      { plannedWorkoutId: IDS.upperB, displayName: "Upper B", toLabel: "Mon", fromLabel: "Fri" },
    ]);
    expect(changes.needsTrainingDay).toEqual([{ plannedWorkoutId: IDS.lowerB, displayName: "Lower B" }]);
    expect(COPY.needsTrainingDay).toBe("Needs a training day");
  });

  it("6: an unchanged sequence item is hidden from the diff", () => {
    const preview = rollForwardPreview();
    const unchanged = { ...preview, upcomingSequence: preview.upcomingSequence.map((item) => (item.plannedWorkoutId === IDS.lowerA ? { ...item, proposedScheduledLocalDate: item.effectiveScheduledLocalDate } : item)) };
    expect(scheduleChanges(unchanged).moves.map((m) => m.plannedWorkoutId)).toEqual([IDS.upperA, IDS.upperB]);
  });

  it("a second roll-forward shows moves from the CURRENT effective date (not the authored one)", () => {
    const preview = rollForwardPreview();
    const second = {
      ...preview,
      athleteLocalDate: "2026-10-10",
      upcomingSequence: [{ plannedWorkoutId: IDS.lowerA, displayName: "Lower A", authoredScheduledLocalDate: "2026-10-07", effectiveScheduledLocalDate: "2026-10-09", proposedScheduledLocalDate: "2026-10-12" }],
    };
    expect(scheduleChanges(second).moves).toEqual([{ plannedWorkoutId: IDS.lowerA, displayName: "Lower A", toLabel: "Mon", fromLabel: "Fri" }]);
  });

  it("day labels are pure calendar arithmetic against the SERVER's athlete-local date", () => {
    expect(shortDayLabel("2026-10-07", "2026-10-07")).toBe("Today");
    expect(shortDayLabel("2026-10-12", "2026-10-07")).toBe("Mon");
    expect(shortDayLabel("2026-10-19", "2026-10-07")).toBe("Mon 19 Oct");
    expect(longDayLabel("2026-10-05", "2026-10-07")).toBe("Monday");
    expect(longDayLabel("2026-09-21", "2026-10-07")).toBe("Monday 21 Sep");
  });

  it("10 (copy): narrow, deterministic review-required reasons; anything else shows no reason, never a raw code", () => {
    expect(reviewRequiredReason("MULTIPLE_MISSED_WORKOUTS")).toBe("More than one workout was missed.");
    expect(reviewRequiredReason("LATER_SESSION_ALREADY_PERFORMED")).toBe("A later workout has already been completed.");
    expect(reviewRequiredReason("NO_KNOWN_TRAINING_SLOT")).toBe("There isn't another known training day yet.");
    for (const code of ["HARD_TIMELINE_CONSTRAINT", "AMBIGUOUS_SEQUENCE", "SOURCE_CONTEXT_NOT_APPLICABLE"] as const) expect(reviewRequiredReason(code)).toBeNull();
    expect(missedWorkoutCard({ kind: "REVIEW_REQUIRED", reasonCode: "AMBIGUOUS_SEQUENCE" })).toEqual({ kind: "REVIEW_REQUIRED", reason: null });
  });

  it("25: TIMEZONE_REQUIRED -> a retryable card (not fatal)", () => {
    expect(missedWorkoutCard({ kind: "TIMEZONE_REQUIRED", retrying: false })).toEqual({ kind: "TIMEZONE_REQUIRED", retrying: false });
    expect(COPY.timeZoneRequired).toBe("Set your training timezone to adjust missed workouts.");
  });
});
