import { describe, expect, it } from "vitest";
import type { MissedWorkoutInputV1, MissedWorkoutPlannedWorkoutV1 } from "./input.js";
import { evaluateMissedWorkout, missedWorkoutPolicyV1 } from "./policy.js";
import { isLocalDate } from "./validate-input.js";

/**
 * Missed Workout / Schedule Adaptation V1 — pure policy tests
 * (docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md). One worked fixture:
 * a Mon/Wed/Fri program, cycle 1 = A (Mon 10-05), B (Wed 10-07),
 * C (Fri 10-09); cycle 2 starts with D (Mon 10-12). "Today" is Wednesday
 * 2026-10-07 unless a test says otherwise.
 */
const TODAY = "2026-10-07";
const VERSION = "pv-1";

function workout(id: string, cycle: number, order: number, date: string | null, overrides: Partial<MissedWorkoutPlannedWorkoutV1> = {}): MissedWorkoutPlannedWorkoutV1 {
  return { plannedWorkoutId: id, programVersionId: VERSION, trainingCycleOrder: cycle, workoutOrder: order, scheduledLocalDate: date, status: "PLANNED", canonicalSessionStatus: null, ...overrides };
}

const A = (o: Partial<MissedWorkoutPlannedWorkoutV1> = {}) => workout("A", 1, 1, "2026-10-05", o);
const B = (o: Partial<MissedWorkoutPlannedWorkoutV1> = {}) => workout("B", 1, 2, "2026-10-07", o);
const C = (o: Partial<MissedWorkoutPlannedWorkoutV1> = {}) => workout("C", 1, 3, "2026-10-09", o);
const D = (o: Partial<MissedWorkoutPlannedWorkoutV1> = {}) => workout("D", 2, 1, "2026-10-12", o);

function input(overrides: Partial<MissedWorkoutInputV1> = {}): MissedWorkoutInputV1 {
  return {
    athleteLocalDate: TODAY,
    applicableProgramVersionId: VERSION,
    timelineConstraint: "FLEXIBLE",
    plannedWorkouts: [A(), B(), C(), D()],
    validTrainingSlots: ["2026-10-07", "2026-10-09", "2026-10-12"],
    ...overrides,
  };
}

function decide(i: MissedWorkoutInputV1) {
  const result = evaluateMissedWorkout(i);
  if (!result.ok) throw new Error(`invalid input: ${JSON.stringify(result.error)}`);
  return result.value.data;
}

describe("NO_CHANGE — nothing actionable", () => {
  it("1/2: future and today's workouts are not missed (today = Monday, A is today)", () => {
    expect(decide(input({ athleteLocalDate: "2026-10-05", validTrainingSlots: ["2026-10-05"] }))).toEqual({ resultKind: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
  });

  it("3: a past occurrence with its canonical session (completed or active) is not missed", () => {
    expect(decide(input({ plannedWorkouts: [A({ canonicalSessionStatus: "COMPLETED" }), B(), C(), D()] })).resultKind).toBe("NO_CHANGE");
    expect(decide(input({ plannedWorkouts: [A({ canonicalSessionStatus: "ACTIVE" }), B(), C(), D()] })).resultKind).toBe("NO_CHANGE");
  });

  it.each(["SKIPPED", "CANCELLED", "RESCHEDULED"] as const)("27: an existing %s occurrence follows its domain meaning — never resurrected as missed", (status) => {
    const result = decide(input({ plannedWorkouts: [A({ status }), B(), C(), D()] }));
    expect(result).toEqual({ resultKind: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" });
  });

  it("an unscheduled (null-date) workout can never be missed", () => {
    expect(decide(input({ plannedWorkouts: [A({ scheduledLocalDate: null }), B(), C()] })).resultKind).toBe("NO_CHANGE");
  });

  it("no plan input at all -> NO_CHANGE", () => {
    expect(decide(input({ plannedWorkouts: [], applicableProgramVersionId: null })).resultKind).toBe("NO_CHANGE");
  });
});

describe("ROLL_FORWARD — SEQUENCE BEFORE CALENDAR", () => {
  it("4/5/6/7: one missed workout becomes the next session; authored order is preserved; the original next is displaced, not deleted", () => {
    expect(decide(input())).toEqual({
      resultKind: "ROLL_FORWARD",
      reasonCode: "SINGLE_MISSED_WORKOUT",
      missedWorkoutId: "A",
      recommendedNextWorkoutId: "A",
      originalNextWorkoutId: "B",
      sequence: ["A", "B", "C", "D"],
      nextTrainingSlot: "2026-10-07",
    });
  });

  it("8/9: the result is never a skip and never a merged/double session (exactly one recommended next workout, no duplicates)", () => {
    const result = decide(input());
    if (result.resultKind !== "ROLL_FORWARD") throw new Error(result.resultKind);
    expect(result.sequence).toContain("A"); // not skipped
    expect(new Set(result.sequence).size).toBe(result.sequence.length); // nothing combined/duplicated
    expect(Object.keys(result).sort()).toEqual(["missedWorkoutId", "nextTrainingSlot", "originalNextWorkoutId", "reasonCode", "recommendedNextWorkoutId", "resultKind", "sequence"]);
  });

  it("10/11: an explicit future slot is used as given — no date is invented (Mon/Wed/Fri: the next slot after a Tuesday open is Wednesday)", () => {
    const result = decide(input({ athleteLocalDate: "2026-10-06", validTrainingSlots: ["2026-10-09", "2026-10-07"] }));
    expect(result).toMatchObject({ resultKind: "ROLL_FORWARD", nextTrainingSlot: "2026-10-07" });
  });

  it("10: opening the app on a day is NOT availability — today counts only when supplied as a slot", () => {
    const withoutToday = decide(input({ athleteLocalDate: "2026-10-06", validTrainingSlots: ["2026-10-07"] }));
    expect(withoutToday).toMatchObject({ nextTrainingSlot: "2026-10-07" });
    const withToday = decide(input({ athleteLocalDate: "2026-10-06", validTrainingSlots: ["2026-10-06", "2026-10-07"] }));
    expect(withToday).toMatchObject({ nextTrainingSlot: "2026-10-06" });
  });

  it("later already-resolved occurrences (SKIPPED/CANCELLED) are not pulled back into the sequence", () => {
    const result = decide(input({ plannedWorkouts: [A(), B({ status: "SKIPPED" }), C(), D()] }));
    expect(result).toMatchObject({ resultKind: "ROLL_FORWARD", originalNextWorkoutId: "C", sequence: ["A", "C", "D"] });
  });

  it("a missed workout that is last in the supplied plan rolls forward with no original next", () => {
    const result = decide(input({ plannedWorkouts: [A()] }));
    expect(result).toMatchObject({ resultKind: "ROLL_FORWARD", originalNextWorkoutId: null, sequence: ["A"] });
  });
});

describe("REVIEW_REQUIRED", () => {
  it("12: no known future training slot -> NO_KNOWN_TRAINING_SLOT (never 'tomorrow')", () => {
    expect(decide(input({ validTrainingSlots: [] }))).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_KNOWN_TRAINING_SLOT", missedWorkoutIds: ["A"] });
    expect(decide(input({ validTrainingSlots: ["2026-10-01", "2026-10-06"] }))).toMatchObject({ reasonCode: "NO_KNOWN_TRAINING_SLOT" }); // past slots are not future opportunities
  });

  it("13: two missed unresolved workouts -> MULTIPLE_MISSED_WORKOUTS", () => {
    const result = decide(input({ athleteLocalDate: "2026-10-08" }));
    expect(result).toEqual({ resultKind: "REVIEW_REQUIRED", reasonCode: "MULTIPLE_MISSED_WORKOUTS", missedWorkoutIds: ["A", "B"], performedLaterWorkoutIds: [] });
  });

  it.each(["ACTIVE", "COMPLETED"] as const)("14/15/16: a LATER session already %s -> LATER_SESSION_ALREADY_PERFORMED; history is never reordered", (status) => {
    const result = decide(input({ athleteLocalDate: "2026-10-08", plannedWorkouts: [A(), B({ canonicalSessionStatus: status }), C(), D()] }));
    expect(result).toEqual({ resultKind: "REVIEW_REQUIRED", reasonCode: "LATER_SESSION_ALREADY_PERFORMED", missedWorkoutIds: ["A"], performedLaterWorkoutIds: ["B"] });
  });

  it.each([
    ["two workouts share one authored position", [A(), workout("B", 1, 1, "2026-10-07"), C()]],
    ["dates run backwards against the authored order", [A(), B({ scheduledLocalDate: "2026-10-10" }), C()]],
  ])("17: ambiguous authored ordering (%s) -> AMBIGUOUS_SEQUENCE", (_label, plannedWorkouts) => {
    expect(decide(input({ plannedWorkouts }))).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "AMBIGUOUS_SEQUENCE" });
  });

  it("18: HARD_DEADLINE -> HARD_TIMELINE_CONSTRAINT (no automatic roll forward, no skip)", () => {
    expect(decide(input({ timelineConstraint: "HARD_DEADLINE" }))).toMatchObject({ resultKind: "REVIEW_REQUIRED", reasonCode: "HARD_TIMELINE_CONSTRAINT", missedWorkoutIds: ["A"] });
  });

  it("18: HARD_DEADLINE with nothing missed is still NO_CHANGE", () => {
    expect(decide(input({ timelineConstraint: "HARD_DEADLINE", athleteLocalDate: "2026-10-05" })).resultKind).toBe("NO_CHANGE");
  });

  it("19: the missed occurrence no longer belongs to the applicable plan -> SOURCE_CONTEXT_NOT_APPLICABLE", () => {
    expect(decide(input({ applicableProgramVersionId: "pv-2" }))).toMatchObject({ reasonCode: "SOURCE_CONTEXT_NOT_APPLICABLE", missedWorkoutIds: ["A"] });
    expect(decide(input({ applicableProgramVersionId: null }))).toMatchObject({ reasonCode: "SOURCE_CONTEXT_NOT_APPLICABLE" });
  });

  it("another ProgramVersion's occurrences never interleave with the applicable sequence", () => {
    const foreign = workout("X", 1, 2, "2026-10-08", { programVersionId: "pv-old" });
    expect(decide(input({ plannedWorkouts: [A(), foreign, B(), C()] }))).toMatchObject({ resultKind: "ROLL_FORWARD", sequence: ["A", "B", "C"] });
  });

  it("precedence is fixed: HARD_DEADLINE beats MULTIPLE, MULTIPLE beats a performed later session", () => {
    expect(decide(input({ athleteLocalDate: "2026-10-08", timelineConstraint: "HARD_DEADLINE" }))).toMatchObject({ reasonCode: "HARD_TIMELINE_CONSTRAINT" });
    expect(decide(input({ athleteLocalDate: "2026-10-10", plannedWorkouts: [A(), B(), C({ canonicalSessionStatus: "COMPLETED" }), D()] }))).toMatchObject({ reasonCode: "MULTIPLE_MISSED_WORKOUTS" });
  });
});

describe("boundaries and invariants", () => {
  it("26: local-date boundary — yesterday is missed, today is not", () => {
    const plannedWorkouts = [workout("Y", 1, 1, "2026-10-06"), workout("T", 1, 2, "2026-10-07")];
    expect(decide(input({ plannedWorkouts }))).toMatchObject({ resultKind: "ROLL_FORWARD", missedWorkoutId: "Y", originalNextWorkoutId: "T" });
  });

  it("20/21/22/23: mode, priority tiers, progression or memory hints in the input never change the result; the output carries no such fields", () => {
    const base = decide(input());
    const noisy = { ...input(), experienceMode: "GUIDED", coached: true, priorityTier: "TIER_3", progression: { lastDecision: "INCREASE_LOAD" }, athleteMemory: ["skips mondays"] } as unknown as MissedWorkoutInputV1;
    for (const experienceMode of ["GUIDED", "ADAPTIVE", "EXPERT"]) {
      expect(decide({ ...noisy, experienceMode } as unknown as MissedWorkoutInputV1)).toEqual(base);
    }
    const serialized = JSON.stringify(base);
    for (const forbidden of ["progression", "Progression", "memory", "Memory", "deload", "tier", "mode"]) expect(serialized).not.toContain(forbidden);
  });

  it("24: repeated identical input -> identical result", () => {
    expect(decide(input())).toEqual(decide(input()));
    expect(missedWorkoutPolicyV1.decide(input())).toEqual(missedWorkoutPolicyV1.decide(input()));
  });

  it("25: reversed/shuffled input rows with the same authored order -> identical result", () => {
    expect(decide(input({ plannedWorkouts: [D(), C(), B(), A()] }))).toEqual(decide(input()));
    expect(decide(input({ athleteLocalDate: "2026-10-08", plannedWorkouts: [C(), A(), D(), B()] }))).toEqual(decide(input({ athleteLocalDate: "2026-10-08" })));
  });

  it("the input object is never mutated", () => {
    const i = input({ plannedWorkouts: [D(), C(), B(), A()], validTrainingSlots: ["2026-10-12", "2026-10-07"] });
    const before = JSON.stringify(i);
    decide(i);
    expect(JSON.stringify(i)).toBe(before);
  });

  it("the decision carries the policy version missed-workout/v1", () => {
    const result = evaluateMissedWorkout(input());
    if (!result.ok) throw new Error("invalid");
    expect(`${result.value.version.engine}/${result.value.version.policy}`).toBe("missed-workout/v1");
  });
});

describe("input validation (structural, fail closed)", () => {
  it.each([
    ["INVALID_LOCAL_DATE", input({ athleteLocalDate: "2026-02-30" })],
    ["INVALID_LOCAL_DATE", input({ athleteLocalDate: "2026-10-07T00:00:00Z" })],
    ["INVALID_LOCAL_DATE", input({ validTrainingSlots: ["tomorrow"] })],
    ["INVALID_LOCAL_DATE", input({ plannedWorkouts: [A({ scheduledLocalDate: "05/10/2026" })] })],
    ["UNSUPPORTED_TIMELINE_CONSTRAINT", input({ timelineConstraint: "PEAKING" as never })],
    ["DUPLICATE_PLANNED_WORKOUT_ID", input({ plannedWorkouts: [A(), A()] })],
    ["INVALID_ORDER", input({ plannedWorkouts: [A({ workoutOrder: 1.5 })] })],
    ["UNSUPPORTED_STATUS", input({ plannedWorkouts: [A({ status: "MISSED" as never })] })],
    ["UNSUPPORTED_SESSION_STATUS", input({ plannedWorkouts: [A({ canonicalSessionStatus: "ABANDONED" as never })] })],
  ])("rejects %s", (reason, i) => {
    const result = evaluateMissedWorkout(i);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(reason);
  });

  it("local dates are strict calendar days (leap years included)", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2100-02-29")).toBe(false);
    expect(isLocalDate("2000-02-29")).toBe(true);
  });
});
