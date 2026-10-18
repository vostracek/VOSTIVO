import { describe, expect, it } from "vitest";
import type { AvailableTimeExerciseV1, AvailableTimeInputV1, AvailableTimeSetV1 } from "./input.js";
import { validateAvailableTimeInput } from "./validate-input.js";

function set(overrides: Partial<AvailableTimeSetV1> = {}): AvailableTimeSetV1 {
  return { setKey: "s1", orderIndex: 1, setType: "WORKING", restSeconds: 0, ...overrides };
}

function exercise(overrides: Partial<AvailableTimeExerciseV1> = {}): AvailableTimeExerciseV1 {
  return { exerciseKey: "e1", orderIndex: 1, priorityTier: "TIER_1", minimumWorkingSets: 1, sets: [set()], ...overrides };
}

function input(overrides: Partial<AvailableTimeInputV1> = {}): AvailableTimeInputV1 {
  return { availableTimeSeconds: 600, exercises: [exercise()], ...overrides };
}

describe("validateAvailableTimeInput (Available-Time Adaptation V1, §17)", () => {
  it("AT-VALID-001: a well-formed input is accepted unchanged (ok, same reference)", () => {
    const valid = input();
    const result = validateAvailableTimeInput(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(valid);
  });

  it("AT-VALID-002: negative availableTimeSeconds is rejected", () => {
    expect(validateAvailableTimeInput(input({ availableTimeSeconds: -1 }))).toEqual({ ok: false, error: { reason: "NEGATIVE_AVAILABLE_TIME" } });
  });

  it("AT-VALID-003: no exercises at all is rejected", () => {
    expect(validateAvailableTimeInput(input({ exercises: [] }))).toEqual({ ok: false, error: { reason: "NO_EXERCISES" } });
  });

  it("AT-VALID-004: duplicate exercise key is rejected", () => {
    const result = validateAvailableTimeInput(
      input({ exercises: [exercise({ exerciseKey: "e1", orderIndex: 1 }), exercise({ exerciseKey: "e1", orderIndex: 2 })] }),
    );
    expect(result).toEqual({ ok: false, error: { reason: "DUPLICATE_EXERCISE_KEY", exerciseKey: "e1" } });
  });

  it("AT-VALID-005: duplicate exercise orderIndex is rejected", () => {
    const result = validateAvailableTimeInput(
      input({ exercises: [exercise({ exerciseKey: "e1", orderIndex: 1 }), exercise({ exerciseKey: "e2", orderIndex: 1 })] }),
    );
    expect(result).toEqual({ ok: false, error: { reason: "DUPLICATE_EXERCISE_ORDER_INDEX", orderIndex: 1 } });
  });

  it("AT-VALID-006: negative minimumWorkingSets is rejected", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ minimumWorkingSets: -1 })] }));
    expect(result).toEqual({ ok: false, error: { reason: "NEGATIVE_MINIMUM_WORKING_SETS", exerciseKey: "e1" } });
  });

  it("AT-VALID-007: minimumWorkingSets exceeding the actual WORKING set count is rejected", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ minimumWorkingSets: 2, sets: [set()] })] }));
    expect(result).toEqual({ ok: false, error: { reason: "MINIMUM_EXCEEDS_WORKING_SET_COUNT", exerciseKey: "e1" } });
  });

  it("AT-VALID-008: no exercise with a positive minimum is rejected — prevents an empty-workout minimum", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ minimumWorkingSets: 0 })] }));
    expect(result).toEqual({ ok: false, error: { reason: "NO_EXERCISE_WITH_POSITIVE_MINIMUM" } });
  });

  it("AT-VALID-009: an exercise with zero sets is rejected", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ sets: [], minimumWorkingSets: 0 })] }));
    // NO_SETS is checked before the working-set-count derived checks.
    expect(result).toEqual({ ok: false, error: { reason: "NO_SETS", exerciseKey: "e1" } });
  });

  it("AT-VALID-010: duplicate set key within one exercise is rejected", () => {
    const result = validateAvailableTimeInput(
      input({ exercises: [exercise({ sets: [set({ setKey: "s1", orderIndex: 1 }), set({ setKey: "s1", orderIndex: 2 })] })] }),
    );
    expect(result).toEqual({ ok: false, error: { reason: "DUPLICATE_SET_KEY", exerciseKey: "e1", setKey: "s1" } });
  });

  it("AT-VALID-011: duplicate set orderIndex within one exercise is rejected", () => {
    const result = validateAvailableTimeInput(
      input({ exercises: [exercise({ sets: [set({ setKey: "s1", orderIndex: 1 }), set({ setKey: "s2", orderIndex: 1 })] })] }),
    );
    expect(result).toEqual({ ok: false, error: { reason: "DUPLICATE_SET_ORDER_INDEX", exerciseKey: "e1", orderIndex: 1 } });
  });

  it("AT-VALID-012: an unsupported set type is rejected (defense-in-depth, runtime boundary)", () => {
    const result = validateAvailableTimeInput(
      input({ exercises: [exercise({ sets: [set({ setType: "DROPSET" as unknown as "WORKING" })] })] }),
    );
    expect(result).toEqual({ ok: false, error: { reason: "UNSUPPORTED_SET_TYPE", exerciseKey: "e1", setKey: "s1" } });
  });

  it("AT-VALID-013: missing/invalid restSeconds is rejected — never guessed (§9)", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ sets: [set({ restSeconds: -5 })] })] }));
    expect(result).toEqual({ ok: false, error: { reason: "INVALID_REST_SECONDS", exerciseKey: "e1", setKey: "s1" } });
  });

  it("AT-VALID-014: an unsupported priority tier is rejected", () => {
    const result = validateAvailableTimeInput(input({ exercises: [exercise({ priorityTier: "TIER_0" as unknown as "TIER_1" })] }));
    expect(result).toEqual({ ok: false, error: { reason: "UNSUPPORTED_PRIORITY_TIER", exerciseKey: "e1" } });
  });

  it("AT-VALID-015: a negative exercise/set orderIndex is rejected", () => {
    expect(validateAvailableTimeInput(input({ exercises: [exercise({ orderIndex: -1 })] }))).toEqual({
      ok: false,
      error: { reason: "INVALID_EXERCISE_ORDER_INDEX", exerciseKey: "e1" },
    });
    expect(validateAvailableTimeInput(input({ exercises: [exercise({ sets: [set({ orderIndex: -1 })] })] }))).toEqual({
      ok: false,
      error: { reason: "INVALID_SET_ORDER_INDEX", exerciseKey: "e1", setKey: "s1" },
    });
  });
});
