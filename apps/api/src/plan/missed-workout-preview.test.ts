import { describe, expect, it } from "vitest";
import {
  buildMissedWorkoutInput,
  evaluateMissedWorkoutPreview,
  computeMissedWorkoutPreview,
  deriveKnownTrainingSlots,
  type MissedWorkoutPreviewSource,
  type ScheduleOccurrenceRow,
} from "./missed-workout-preview.js";

/**
 * Pure Slice B normalization (no DB): current-block resolution, authored
 * slot derivation, engine input shape, response mapping and fingerprint
 * determinism. The policy itself is covered by packages/training-engine;
 * real-Postgres orchestration by missed-workout-preview.integration.test.ts.
 */

const VERSION = "00000000-0000-7000-8000-00000000000v";
const BLOCK = "00000000-0000-7000-8000-0000000000b1";

function occurrence(id: string, cycleOrder: number, workoutOrder: number, date: string | null, overrides: Partial<ScheduleOccurrenceRow> = {}): ScheduleOccurrenceRow {
  return { plannedWorkoutId: id, displayName: `Workout ${id}`, cycleOrder, workoutOrder, authoredScheduledLocalDate: date, scheduledLocalDate: date, status: "PLANNED", canonicalSessionStatus: null, ...overrides };
}

// The locked fixture: Mon Upper A, Wed Lower A, Fri Upper B, Mon Lower B.
const UPPER_A = occurrence("A", 0, 0, "2026-10-05", { displayName: "Upper A" });
const LOWER_A = occurrence("B", 0, 1, "2026-10-07", { displayName: "Lower A" });
const UPPER_B = occurrence("C", 0, 2, "2026-10-09", { displayName: "Upper B" });
const LOWER_B = occurrence("D", 1, 0, "2026-10-12", { displayName: "Lower B" });

function source(occurrences: readonly ScheduleOccurrenceRow[], overrides: Partial<MissedWorkoutPreviewSource> = {}): MissedWorkoutPreviewSource {
  return {
    athleteProfileId: "athlete-1",
    trainingTimeZone: "Europe/Prague",
    athleteLocalDate: "2026-10-07",
    programVersionId: VERSION,
    trainingBlockId: BLOCK,
    activeScheduleApplicationId: null,
    occurrences,
    timelineConstraint: "FLEXIBLE",
    ...overrides,
  };
}

describe("deriveKnownTrainingSlots", () => {
  it("unresolved dates on/after today, deduplicated and ascending; past dates never", () => {
    const duplicate = occurrence("E", 0, 3, "2026-10-09");
    expect(deriveKnownTrainingSlots([LOWER_B, UPPER_B, duplicate, UPPER_A, LOWER_A], "2026-10-07")).toEqual(["2026-10-07", "2026-10-09", "2026-10-12"]);
  });

  it("a cancelled/skipped/rescheduled-only date or an already-performed date is not a slot", () => {
    const rows = [
      occurrence("X", 0, 0, "2026-10-08", { status: "CANCELLED" }),
      occurrence("Y", 0, 1, "2026-10-10", { status: "SKIPPED" }),
      occurrence("Z", 0, 2, "2026-10-11", { status: "RESCHEDULED" }),
      occurrence("W", 0, 3, "2026-10-13", { canonicalSessionStatus: "COMPLETED" }),
      occurrence("V", 0, 4, "2026-10-14", { status: "AVAILABLE" }),
      occurrence("U", 0, 5, null),
    ];
    expect(deriveKnownTrainingSlots(rows, "2026-10-07")).toEqual(["2026-10-14"]);
  });

  it("a date shared by a cancelled and an unresolved workout is still a slot", () => {
    expect(deriveKnownTrainingSlots([occurrence("X", 0, 0, "2026-10-08", { status: "CANCELLED" }), occurrence("Y", 0, 1, "2026-10-08")], "2026-10-07")).toEqual(["2026-10-08"]);
  });
});

describe("computeMissedWorkoutPreview", () => {
  it("the locked fixture: Upper A missed -> ROLL_FORWARD into today's slot, Lower A displaced", () => {
    const preview = computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B]));
    expect(preview).toMatchObject({
      policyVersion: "missed-workout/v1",
      athleteLocalDate: "2026-10-07",
      trainingTimeZone: "Europe/Prague",
      result: "ROLL_FORWARD",
      reasonCode: "SINGLE_MISSED_WORKOUT",
      missedWorkout: { plannedWorkoutId: "A", displayName: "Upper A", scheduledLocalDate: "2026-10-05" },
      recommendedNextWorkout: { plannedWorkoutId: "A", displayName: "Upper A" },
      originalNextWorkout: { plannedWorkoutId: "B", displayName: "Lower A", scheduledLocalDate: "2026-10-07" },
      nextTrainingSlot: "2026-10-07",
      upcomingSequence: [
        { plannedWorkoutId: "A", displayName: "Upper A", authoredScheduledLocalDate: "2026-10-05" },
        { plannedWorkoutId: "B", displayName: "Lower A", authoredScheduledLocalDate: "2026-10-07" },
        { plannedWorkoutId: "C", displayName: "Upper B", authoredScheduledLocalDate: "2026-10-09" },
        { plannedWorkoutId: "D", displayName: "Lower B", authoredScheduledLocalDate: "2026-10-12" },
      ],
    });
    expect(preview.previewFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("row order never matters: same input, same preview and fingerprint", () => {
    const a = computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B]));
    const b = computeMissedWorkoutPreview(source([LOWER_B, UPPER_B, LOWER_A, UPPER_A]));
    expect(b).toEqual(a);
  });

  it("the engine input carries the version, authored order and derived slots — never client data", () => {
    const input = buildMissedWorkoutInput(source([LOWER_B, UPPER_A, LOWER_A, UPPER_B]));
    expect(input.applicableProgramVersionId).toBe(VERSION);
    expect(input.plannedWorkouts.map((w) => w.plannedWorkoutId)).toEqual(["A", "B", "C", "D"]);
    expect(input.plannedWorkouts.every((w) => w.programVersionId === VERSION)).toBe(true);
    expect(input.validTrainingSlots).toEqual(["2026-10-07", "2026-10-09", "2026-10-12"]);
  });

  it("nothing past due -> NO_CHANGE; no plan -> NO_CHANGE", () => {
    expect(computeMissedWorkoutPreview(source([UPPER_A, LOWER_A], { athleteLocalDate: "2026-10-05" }))).toMatchObject({ result: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
    expect(computeMissedWorkoutPreview(source([], { programVersionId: null, trainingBlockId: null }))).toMatchObject({ result: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
  });

  it("REVIEW_REQUIRED carries only ids, no sequence", () => {
    const performed = { ...LOWER_A, canonicalSessionStatus: "COMPLETED" as const };
    const preview = computeMissedWorkoutPreview(source([UPPER_A, performed, UPPER_B, LOWER_B]));
    expect(preview).toEqual({
      policyVersion: "missed-workout/v1",
      athleteLocalDate: "2026-10-07",
      trainingTimeZone: "Europe/Prague",
      previewFingerprint: preview.previewFingerprint,
      result: "REVIEW_REQUIRED",
      reasonCode: "LATER_SESSION_ALREADY_PERFORMED",
      missedWorkoutIds: ["A"],
      performedLaterWorkoutIds: ["B"],
    });
  });

  it("HARD_DEADLINE through the source seam -> REVIEW HARD_TIMELINE_CONSTRAINT", () => {
    expect(computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { timelineConstraint: "HARD_DEADLINE" }))).toMatchObject({ result: "REVIEW_REQUIRED", reasonCode: "HARD_TIMELINE_CONSTRAINT" });
  });

  describe("fingerprint", () => {
    const base = computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B])).previewFingerprint;

    it.each<[string, MissedWorkoutPreviewSource]>([
      ["time zone", source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { trainingTimeZone: "Europe/Vienna" })],
      ["athlete", source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { athleteProfileId: "athlete-2" })],
      ["program version", source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { programVersionId: "00000000-0000-7000-8000-0000000000v2" })],
      ["block", source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { trainingBlockId: "other-block" })],
      ["a workout's date", source([UPPER_A, LOWER_A, { ...UPPER_B, scheduledLocalDate: "2026-10-10" }, LOWER_B])],
      ["a workout's status", source([UPPER_A, LOWER_A, { ...UPPER_B, status: "AVAILABLE" }, LOWER_B])],
      ["a workout's order", source([UPPER_A, LOWER_A, { ...UPPER_B, workoutOrder: 5 }, LOWER_B])],
      ["a canonical session", source([UPPER_A, LOWER_A, UPPER_B, { ...LOWER_B, canonicalSessionStatus: "ACTIVE" }])],
      ["timeline", source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { timelineConstraint: "HARD_DEADLINE" })],
    ])("changes when the %s changes", (_label, changed) => {
      expect(computeMissedWorkoutPreview(changed).previewFingerprint).not.toBe(base);
    });

    it("changes with the local date (and so with the decision/slots)", () => {
      expect(computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B], { athleteLocalDate: "2026-10-08" })).previewFingerprint).not.toBe(base);
    });

    it("display names are presentation only and never change it", () => {
      expect(computeMissedWorkoutPreview(source([{ ...UPPER_A, displayName: "Renamed" }, LOWER_A, UPPER_B, LOWER_B])).previewFingerprint).toBe(base);
    });
  });
});

describe("Slice C — effective schedule input", () => {
  /** The locked example after one applied roll-forward: A->Wed, B->Fri, C->Mon, D carryover. */
  const EFFECTIVE = [
    { ...UPPER_A, scheduledLocalDate: "2026-10-07" },
    { ...LOWER_A, scheduledLocalDate: "2026-10-09" },
    { ...UPPER_B, scheduledLocalDate: "2026-10-12" },
    { ...LOWER_B, scheduledLocalDate: null },
  ];

  it("the policy reads EFFECTIVE dates: on Wednesday A is not missed any more", () => {
    expect(computeMissedWorkoutPreview(source(EFFECTIVE, { activeScheduleApplicationId: "app-1" }))).toMatchObject({ result: "NO_CHANGE" });
  });

  it("on Thursday A is missed on its effective Wednesday; a carryover establishes no slot and gets no invented date", () => {
    const evaluation = evaluateMissedWorkoutPreview(source(EFFECTIVE, { activeScheduleApplicationId: "app-1", athleteLocalDate: "2026-10-08" }));
    expect(evaluation.input.validTrainingSlots).toEqual(["2026-10-09", "2026-10-12"]);
    expect(evaluation.preview).toMatchObject({ result: "ROLL_FORWARD", missedWorkout: { plannedWorkoutId: "A", scheduledLocalDate: "2026-10-07" } });
    expect(evaluation.proposedAssignments).toEqual([
      { plannedWorkoutId: "A", effectiveScheduledLocalDate: "2026-10-09" },
      { plannedWorkoutId: "B", effectiveScheduledLocalDate: "2026-10-12" },
      { plannedWorkoutId: "C", effectiveScheduledLocalDate: null },
      { plannedWorkoutId: "D", effectiveScheduledLocalDate: null },
    ]);
  });

  it("the preview exposes authored, current effective and proposed dates per sequence item", () => {
    const preview = computeMissedWorkoutPreview(source([UPPER_A, LOWER_A, UPPER_B, LOWER_B]));
    if (preview.result !== "ROLL_FORWARD") throw new Error("expected ROLL_FORWARD");
    expect(preview.upcomingSequence.map((s) => [s.plannedWorkoutId, s.authoredScheduledLocalDate, s.effectiveScheduledLocalDate, s.proposedScheduledLocalDate])).toEqual([
      ["A", "2026-10-05", "2026-10-05", "2026-10-07"],
      ["B", "2026-10-07", "2026-10-07", "2026-10-09"],
      ["C", "2026-10-09", "2026-10-09", "2026-10-12"],
      ["D", "2026-10-12", "2026-10-12", null],
    ]);
  });

  it("the fingerprint changes with the active application identity and with authored-only changes", () => {
    const base = computeMissedWorkoutPreview(source(EFFECTIVE, { activeScheduleApplicationId: "app-1", athleteLocalDate: "2026-10-08" })).previewFingerprint;
    expect(computeMissedWorkoutPreview(source(EFFECTIVE, { activeScheduleApplicationId: "app-2", athleteLocalDate: "2026-10-08" })).previewFingerprint).not.toBe(base);
    const authoredMoved = EFFECTIVE.map((o) => (o.plannedWorkoutId === "D" ? { ...o, authoredScheduledLocalDate: "2026-10-13" } : o));
    expect(computeMissedWorkoutPreview(source(authoredMoved, { activeScheduleApplicationId: "app-1", athleteLocalDate: "2026-10-08" })).previewFingerprint).not.toBe(base);
  });
});

