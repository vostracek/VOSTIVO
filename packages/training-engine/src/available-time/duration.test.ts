import { describe, expect, it } from "vitest";
import type { AvailableTimeSetV1 } from "./input.js";
import { estimateExerciseDurationSeconds, estimateSessionDurationSeconds } from "./duration.js";

function set(overrides: Partial<AvailableTimeSetV1> = {}): AvailableTimeSetV1 {
  return { setKey: "s", orderIndex: 1, setType: "WORKING", restSeconds: 0, ...overrides };
}

describe("estimateExerciseDurationSeconds (Available-Time Adaptation V1, §8)", () => {
  it("AT-DUR-001: the exact locked worked example — 3 retained sets, rest 120/120, no rest after the last set", () => {
    const sets = [
      set({ setKey: "s1", orderIndex: 1, restSeconds: 120 }),
      set({ setKey: "s2", orderIndex: 2, restSeconds: 120 }),
      set({ setKey: "s3", orderIndex: 3, restSeconds: 999 }), // must be ignored — it's the last retained set
    ];
    expect(estimateExerciseDurationSeconds(sets)).toBe(390);
  });

  it("AT-DUR-002: zero retained sets costs nothing — not even the 60s setup", () => {
    expect(estimateExerciseDurationSeconds([])).toBe(0);
  });

  it("AT-DUR-003: a single retained set costs only setup + one execution, never a rest", () => {
    expect(estimateExerciseDurationSeconds([set({ restSeconds: 500 })])).toBe(60 + 30);
  });

  it("AT-DUR-004: WARM_UP and WORKING sets cost the same 30s execution — no distinction", () => {
    const warmUpOnly = [set({ setType: "WARM_UP", restSeconds: 45 }), set({ setKey: "s2", orderIndex: 2, setType: "WARM_UP" })];
    expect(estimateExerciseDurationSeconds(warmUpOnly)).toBe(60 + 30 + 45 + 30);
  });

  it("AT-DUR-005: input order does not matter — sets are sorted by orderIndex internally", () => {
    const reversed = [
      set({ setKey: "s2", orderIndex: 2, restSeconds: 999 }),
      set({ setKey: "s1", orderIndex: 1, restSeconds: 50 }),
    ];
    expect(estimateExerciseDurationSeconds(reversed)).toBe(60 + 30 + 50 + 30);
  });
});

describe("estimateSessionDurationSeconds", () => {
  it("AT-DUR-006: sums each exercise's own retained-set duration independently", () => {
    const exerciseA = [set({ restSeconds: 100 }), set({ setKey: "s2", orderIndex: 2 })];
    const exerciseB = [set({ setKey: "s3", orderIndex: 1 })];
    expect(estimateSessionDurationSeconds([exerciseA, exerciseB])).toBe(
      estimateExerciseDurationSeconds(exerciseA) + estimateExerciseDurationSeconds(exerciseB),
    );
  });
});
