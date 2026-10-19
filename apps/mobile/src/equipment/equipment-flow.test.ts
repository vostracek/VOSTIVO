import { describe, expect, it } from "vitest";
import type { EquipmentAdaptationPreviewReviewReasonV1, PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { adjustableTodaySession } from "../available-time/available-time-flow";
import { deriveTodayHeroState } from "../plan/today-derivation";
import { EQUIPMENT_COPY, equipmentAdjustedCount, equipmentAdjustedLabel, replacementRows, reviewRequiredMessage, type ReviewPreview } from "./equipment-flow";
import { WORKOUT_ID, adjustPreview, adjustedWorkoutPreview, authoredWorkoutPreview } from "./testing/fixtures";

const adjust = adjustPreview() as ReviewPreview<"ADJUST_SESSION">;

describe("equipment flow presentation (pure)", () => {
  it("ADJUST_SESSION shows ONLY the changed exercises, in authored order, with server display names", () => {
    expect(replacementRows(adjust)).toEqual([
      { plannedExerciseId: adjust.replacements[1]!.plannedExerciseId, authoredName: "Bench Press", substituteName: "Dumbbell Bench Press", prescriptionLine: "3 × 8–12 stays the same" },
      { plannedExerciseId: adjust.replacements[0]!.plannedExerciseId, authoredName: "Overhead Press", substituteName: "Seated Dumbbell Overhead Press", prescriptionLine: "2 × 6–8 stays the same" },
    ]);
  });

  it("the review never shows a load (no load field exists to show; copy says load is resolved for the replacement)", () => {
    const rendered = JSON.stringify(replacementRows(adjust));
    expect(rendered).not.toMatch(/kg|amountMilli|load/i);
    expect(EQUIPMENT_COPY.preserved).toBe("Sets, reps and rest stay the same.");
    expect(EQUIPMENT_COPY.loadResolved).toBe("Load is resolved for the replacement.");
  });

  it("a non-uniform working prescription is described without inventing a rep target", () => {
    const preview = structuredClone(adjust) as unknown as { replacements: { prescription: { sets: { targetReps: unknown }[] } }[] };
    preview.replacements[0]!.prescription.sets[1]!.targetReps = { kind: "EXACT", reps: 5 };
    expect(replacementRows(preview as unknown as ReviewPreview<"ADJUST_SESSION">)[1]!.prescriptionLine).toBe("2 working sets stay the same");
  });

  it.each([
    ["NO_CURATED_SUBSTITUTE", "No automatic substitute fits the equipment you selected."],
    ["NO_AVAILABLE_SUBSTITUTE", "No automatic substitute fits the equipment you selected."],
    ["NO_EQUIVALENT_SUBSTITUTE", "No automatic substitute fits the equipment you selected."],
    ["UNSUPPORTED_EXERCISE_IDENTITY", "One exercise can't be adjusted automatically."],
    ["LOCKED_EXERCISE_UNAVAILABLE", "This exercise is fixed in your plan."],
    ["AMBIGUOUS_SUBSTITUTION", "Vostivo found more than one safe path and won't choose for you."],
    ["SUBSTITUTE_CONFLICT", "Vostivo found more than one safe path and won't choose for you."],
    ["UNSUPPORTED_PRESCRIPTION_COMPATIBILITY", "One exercise can't keep its sets and reps with the equipment you selected."],
  ] as [EquipmentAdaptationPreviewReviewReasonV1, string][])("REVIEW_REQUIRED %s -> calm user copy, never the raw enum", (code, message) => {
    expect(reviewRequiredMessage(code)).toBe(message);
    expect(reviewRequiredMessage(code)).not.toContain(code);
    expect(reviewRequiredMessage(code)).not.toMatch(/[A-Z]{3,}_/);
  });

  it("Today's quiet state counts the server's effective substitutions only", () => {
    expect(equipmentAdjustedCount(authoredWorkoutPreview())).toBe(0);
    expect(equipmentAdjustedLabel(0)).toBeNull();
    expect(equipmentAdjustedCount(adjustedWorkoutPreview())).toBe(2);
    expect(equipmentAdjustedLabel(2)).toBe("Equipment adjusted · 2 exercises");
    expect(equipmentAdjustedLabel(1)).toBe("Equipment adjusted · 1 exercise");
  });
});

describe("Today entry point eligibility (shared with Adjust time — one interpretation of Today)", () => {
  const session = (overrides: Partial<PlanSessionSummaryV1> = {}): PlanSessionSummaryV1 => ({
    plannedWorkoutId: WORKOUT_ID,
    name: "Upper Body A",
    focus: null,
    order: 1,
    scheduledDate: "2026-10-12",
    authoredScheduledDate: "2026-10-12",
    scheduleSource: "AUTHORED",
    estimatedDurationMinutes: 60,
    displayStatus: "TODAY",
    hasActiveSession: false, hasAppliedProgression: false,
    ...overrides,
  });

  it("a training day offers Equipment for exactly the Hero's planned workout (Start Workout stays the Hero's own action)", () => {
    const hero = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: overview([session()]) } });
    expect(hero.kind).toBe("training-day");
    expect(adjustableTodaySession(hero)?.plannedWorkoutId).toBe(WORKOUT_ID);
  });

  it("a Missed-Workout moved workout (authored Tuesday, effective Today) keeps its SAME PlannedWorkout id as the target", () => {
    const moved = session({ authoredScheduledDate: "2026-10-06", scheduleSource: "ADAPTED" });
    expect(adjustableTodaySession(deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: overview([moved]) } }))?.plannedWorkoutId).toBe(WORKOUT_ID);
  });

  it("an already-started occurrence (or Resume) hides the pre-start equipment adjustment", () => {
    expect(adjustableTodaySession(deriveTodayHeroState({ hasActiveSessionAnywhere: true, overview: { status: "ready", overview: overview([session()]) } }))).toBeNull();
    expect(adjustableTodaySession(deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: overview([session({ hasActiveSession: true })]) } }))).toBeNull();
    expect(adjustableTodaySession(deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: overview([session({ displayStatus: "COMPLETED" })]) } }))).toBeNull();
  });
});

function overview(sessions: PlanSessionSummaryV1[]): PlanOverviewV1 {
  return { currentBlock: { id: "block-1" }, sessions, weeklyFocus: [], schedule: null } as unknown as PlanOverviewV1;
}
