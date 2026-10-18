import { describe, expect, it } from "vitest";
import type { AvailableTimeExerciseV1, AvailableTimeInputV1, AvailableTimeSetV1 } from "./input.js";
import { evaluateAvailableTime } from "./policy.js";

/**
 * Available-Time Adaptation V1 — pure engine tests (locked §18/§19's
 * required example classes A-M plus the monotonicity invariant). A single
 * shared fixture — 4 exercises, every WORKING set costing 60s + 30s = 90s
 * marginal, so budgets can be reasoned about exactly — is reused across
 * the whole ordering/cascade example set (B-J), matching this codebase's
 * own convention of one clear worked fixture rather than a fresh ad hoc
 * one per assertion.
 *
 * Fixture: bench (TIER_1, order 1, min 2, 3 working @60s rest, 1 warm-up)
 * -> 300s at 2 working sets + the warm-up, 90s marginal per extra working
 * set (each retained set costs 30s execution + 60s rest to the one
 * before it — a whole-exercise 60s setup is amortized once, so a fully
 * intact exercise's own total is `60 + N*30 + (N-1)*60`).
 * row (TIER_2, order 2, min 1, 2 working @60s rest) -> 90s at min (1 set).
 * curl-a (TIER_3, order 3, min 0, 2 working @60s rest).
 * curl-b (TIER_3, order 4, min 0, 2 working @60s rest) — SAME tier as
 * curl-a, LATER order, so it must be reduced first (locked §4).
 *
 * Full session: bench(1 warm-up+3 working)=300 + row(2)=180 + curlA(2)=180
 * + curlB(2)=180 = 840.
 * Structural minimum: bench(1 warm-up+2 working)=210 + row(1)=90 +
 * curlA(0)=0 + curlB(0)=0 = 300.
 */
function workingSet(exerciseKey: string, orderIndex: number, restSeconds = 60): AvailableTimeSetV1 {
  return { setKey: `${exerciseKey}-w${orderIndex}`, orderIndex, setType: "WORKING", restSeconds };
}

function warmUpSet(exerciseKey: string, orderIndex: number): AvailableTimeSetV1 {
  return { setKey: `${exerciseKey}-wu${orderIndex}`, orderIndex, setType: "WARM_UP", restSeconds: 0 };
}

function buildFixtureExercises(): AvailableTimeExerciseV1[] {
  return [
    {
      exerciseKey: "bench",
      orderIndex: 1,
      priorityTier: "TIER_1",
      minimumWorkingSets: 2,
      sets: [warmUpSet("bench", 0), workingSet("bench", 1), workingSet("bench", 2), workingSet("bench", 3)],
    },
    { exerciseKey: "row", orderIndex: 2, priorityTier: "TIER_2", minimumWorkingSets: 1, sets: [workingSet("row", 1), workingSet("row", 2)] },
    { exerciseKey: "curl-a", orderIndex: 3, priorityTier: "TIER_3", minimumWorkingSets: 0, sets: [workingSet("curl-a", 1), workingSet("curl-a", 2)] },
    { exerciseKey: "curl-b", orderIndex: 4, priorityTier: "TIER_3", minimumWorkingSets: 0, sets: [workingSet("curl-b", 1), workingSet("curl-b", 2)] },
  ];
}

function fixtureInput(availableTimeSeconds: number): AvailableTimeInputV1 {
  return { availableTimeSeconds, exercises: buildFixtureExercises() };
}

function retainedWorkingSetKeys(exerciseKey: string, decision: ReturnType<typeof decide>): readonly string[] {
  if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
  const retained = decision.data.retainedExercises.find((e) => e.exerciseKey === exerciseKey);
  return retained?.retainedSetKeys.filter((key) => key.includes("-w") && !key.includes("-wu")) ?? [];
}

function decide(input: AvailableTimeInputV1) {
  const result = evaluateAvailableTime(input);
  if (!result.ok) throw new Error(`expected valid input, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("Available-Time Adaptation V1 — pure engine", () => {
  // A — available >= planned requirement -> NO_CHANGE
  it("AT-POLICY-A: the full session already fits -> NO_CHANGE, no reductions", () => {
    const decision = decide(fixtureInput(840));
    expect(decision.data).toEqual({ resultKind: "NO_CHANGE", reasonCode: "FITS_WITHOUT_CHANGE", availableTimeSeconds: 840, estimatedDurationSeconds: 840 });
  });

  it("AT-POLICY-A2: strictly more available time than required also yields NO_CHANGE", () => {
    const decision = decide(fixtureInput(1000));
    expect(decision.data.resultKind).toBe("NO_CHANGE");
  });

  // B — small deficit -> minimum necessary reduction only, stop immediately
  it("AT-POLICY-B: a small deficit removes exactly one working set and stops immediately", () => {
    const decision = decide(fixtureInput(800));
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(decision.data.removedWorkingSets).toEqual([{ exerciseKey: "curl-b", setKey: "curl-b-w2" }]);
    expect(decision.data.adjustedEstimatedDurationSeconds).toBe(750);
    expect(decision.data.adjustedEstimatedDurationSeconds).toBeLessThanOrEqual(800);
  });

  // C — TIER_3 has multiple removable sets -> reduced before touching TIER_2
  // E — same tier: later exercise (curl-b, order 4) reduced before earlier (curl-a, order 3)
  it("AT-POLICY-C-E: TIER_3 is exhausted (later exercise first) before TIER_2 is ever touched", () => {
    const decision = decide(fixtureInput(500));
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    // Exactly the 4 TIER_3 working sets removed, curl-b's before curl-a's.
    expect(decision.data.removedWorkingSets).toEqual([
      { exerciseKey: "curl-b", setKey: "curl-b-w2" },
      { exerciseKey: "curl-b", setKey: "curl-b-w1" },
      { exerciseKey: "curl-a", setKey: "curl-a-w2" },
      { exerciseKey: "curl-a", setKey: "curl-a-w1" },
    ]);
    expect(decision.data.fullyRemovedExercises).toEqual([{ exerciseKey: "curl-b" }, { exerciseKey: "curl-a" }]);
    // row (TIER_2) and bench (TIER_1) are completely untouched.
    expect(retainedWorkingSetKeys("row", decision)).toEqual(["row-w1", "row-w2"]);
    expect(retainedWorkingSetKeys("bench", decision)).toEqual(["bench-w1", "bench-w2", "bench-w3"]);
  });

  // D — TIER_3 exhausted -> then TIER_2 -> then TIER_1
  it("AT-POLICY-D: after TIER_3 is exhausted, TIER_2 is reduced to its minimum, then TIER_1", () => {
    const decision = decide(fixtureInput(300));
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(decision.data.fullyRemovedExercises).toEqual([{ exerciseKey: "curl-b" }, { exerciseKey: "curl-a" }]);
    expect(retainedWorkingSetKeys("row", decision)).toEqual(["row-w1"]); // reduced to its own minimum (1)
    expect(retainedWorkingSetKeys("bench", decision)).toEqual(["bench-w1", "bench-w2"]); // reduced to its own minimum (2)
    expect(decision.data.adjustedEstimatedDurationSeconds).toBe(300);
    expect(decision.data.adjustedEstimatedDurationSeconds).toBeLessThanOrEqual(300);
  });

  // F — within one exercise, the LAST working set is always removed first (suffix reduction)
  it("AT-POLICY-F: within one exercise the last retained working set is always removed first, never an earlier one", () => {
    const decision = decide(fixtureInput(500));
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    // curl-a lost w2 before w1 (both removed here, but confirms order).
    const curlARemovals = decision.data.removedWorkingSets.filter((r) => r.exerciseKey === "curl-a").map((r) => r.setKey);
    expect(curlARemovals).toEqual(["curl-a-w2", "curl-a-w1"]);
  });

  // G — minimumWorkingSets = 0 -> final working-set removal removes the whole exercise, including warm-ups
  it("AT-POLICY-G: removing the last working set of a zero-minimum exercise fully removes it, warm-ups included", () => {
    const exercises = buildFixtureExercises();
    // Give curl-a a warm-up too, to prove it disappears alongside it.
    const curlA = exercises.find((e) => e.exerciseKey === "curl-a")!;
    const withWarmUp = { ...curlA, sets: [warmUpSet("curl-a", 0), ...curlA.sets] };
    const patched = exercises.map((e) => (e.exerciseKey === "curl-a" ? withWarmUp : e));

    const decision = decide({ availableTimeSeconds: 500, exercises: patched });
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(decision.data.fullyRemovedExercises.map((e) => e.exerciseKey)).toContain("curl-a");
    expect(decision.data.retainedExercises.some((e) => e.exerciseKey === "curl-a")).toBe(false); // gone entirely, warm-up included
  });

  // H — a retained exercise keeps ALL of its warm-ups unchanged
  it("AT-POLICY-H: a retained exercise's warm-up sets are never touched, even after its working sets are reduced", () => {
    const decision = decide(fixtureInput(300)); // bench is reduced 3 -> 2 working sets
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    const bench = decision.data.retainedExercises.find((e) => e.exerciseKey === "bench")!;
    expect(bench.retainedSetKeys).toContain("bench-wu0");
    expect(decision.data.removedWorkingSets.some((r) => r.setKey.includes("wu"))).toBe(false); // never a warm-up in the removal list
  });

  // I — the structural minimum itself is still too long -> CANNOT_FIT_MINIMUM
  it("AT-POLICY-I: available time below the structural minimum (300s) -> CANNOT_FIT_MINIMUM, never violating a minimum", () => {
    const decision = decide(fixtureInput(299));
    expect(decision.data.resultKind).toBe("CANNOT_FIT_MINIMUM");
    if (decision.data.resultKind !== "CANNOT_FIT_MINIMUM") throw new Error("expected CANNOT_FIT_MINIMUM");
    expect(decision.data.reasonCode).toBe("MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME");
    expect(decision.data.originalEstimatedDurationSeconds).toBe(840);
    expect(decision.data.minimumEstimatedDurationSeconds).toBe(300);
    const bench = decision.data.minimumRetainedExercises.find((e) => e.exerciseKey === "bench")!;
    expect(bench.retainedSetKeys.filter((k) => k.includes("-w") && !k.includes("wu"))).toHaveLength(2); // never below its minimum
    const row = decision.data.minimumRetainedExercises.find((e) => e.exerciseKey === "row")!;
    expect(row.retainedSetKeys).toHaveLength(1); // never below its minimum
    expect(decision.data.minimumRetainedExercises.some((e) => e.exerciseKey === "curl-a" || e.exerciseKey === "curl-b")).toBe(false);
  });

  // J — the structural minimum exactly fits -> reached, never reduced further
  it("AT-POLICY-J: available time exactly equal to the structural minimum (300s) fits -> ADJUST_SESSION at exactly the minimum, never below it", () => {
    const decision = decide(fixtureInput(300));
    expect(decision.data.resultKind).toBe("ADJUST_SESSION");
    if (decision.data.resultKind !== "ADJUST_SESSION") throw new Error("expected ADJUST_SESSION");
    expect(decision.data.adjustedEstimatedDurationSeconds).toBe(300);
    expect(retainedWorkingSetKeys("bench", decision)).toHaveLength(2);
    expect(retainedWorkingSetKeys("row", decision)).toHaveLength(1);
  });

  // L, M — determinism: repeated calls produce identical results, input is never mutated
  it("AT-POLICY-L-M: repeated evaluation of the same input is byte-equivalent, and the input object is never mutated", () => {
    const input = fixtureInput(500);
    const beforeSnapshot = JSON.parse(JSON.stringify(input)) as unknown;

    const first = decide(input);
    const second = decide(input);

    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(input))).toEqual(beforeSnapshot); // input untouched by either call
  });

  it("AT-POLICY-NO-CHANGE-EVIDENCE: NO_CHANGE preserves the complete original session (no reductions, no evidence of removal)", () => {
    const decision = decide(fixtureInput(840));
    expect(decision.data).not.toHaveProperty("removedWorkingSets");
    expect(decision.data).not.toHaveProperty("fullyRemovedExercises");
  });

  it("AT-POLICY-VERSION: the decision carries the locked available-time/v1 identity", () => {
    const decision = decide(fixtureInput(840));
    expect(decision.kind).toBe("available-time");
    expect(decision.version).toEqual({ engine: "available-time", policy: "v1" });
  });

  // §19 — monotonicity invariant
  it("AT-POLICY-MONOTONIC: more available time never retains less working work than less available time", () => {
    const budgets = [100, 299, 300, 350, 480, 500, 750, 800, 840, 1000];
    const totalRetainedWorkingSets = budgets.map((budget) => {
      const decision = decide(fixtureInput(budget));
      if (decision.data.resultKind === "NO_CHANGE") return 9; // bench(3)+row(2)+curlA(2)+curlB(2)
      if (decision.data.resultKind === "CANNOT_FIT_MINIMUM") {
        return decision.data.minimumRetainedExercises.reduce((sum, e) => sum + e.retainedSetKeys.filter((k) => k.includes("-w") && !k.includes("wu")).length, 0);
      }
      return decision.data.retainedExercises.reduce((sum, e) => sum + e.retainedSetKeys.filter((k) => k.includes("-w") && !k.includes("wu")).length, 0);
    });

    for (let i = 1; i < totalRetainedWorkingSets.length; i++) {
      expect(totalRetainedWorkingSets[i]).toBeGreaterThanOrEqual(totalRetainedWorkingSets[i - 1]!);
    }
  });

  it("AT-POLICY-INVALID: structurally invalid input returns err, never a decision", () => {
    const result = evaluateAvailableTime({ availableTimeSeconds: -5, exercises: buildFixtureExercises() });
    expect(result).toEqual({ ok: false, error: { reason: "NEGATIVE_AVAILABLE_TIME" } });
  });
});
