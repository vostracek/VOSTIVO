import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PrescribedSetV1 } from "@vostivo/domain";
import { exerciseSetSummary } from "./active-workout-presentation";

function set(order: number, overrides: Partial<PrescribedSetV1> = {}): PrescribedSetV1 {
  return {
    prescriptionSetId: `s${order}`,
    order,
    setType: "WORKING",
    targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
    targetLoad: null,
    restSeconds: null,
    ...overrides,
  } as PrescribedSetV1;
}

describe("Active Workout v2 presentation (Design Integration 01)", () => {
  it("DI-AW-001: '3 × 8–12' counts working sets only, from the real shared target", () => {
    expect(exerciseSetSummary({ sets: [set(0, { setType: "WARM_UP" }), set(1), set(2), set(3)] })).toBe("3 × 8–12");
    expect(exerciseSetSummary({ sets: [set(1, { targetReps: { kind: "EXACT", reps: 5 } } as Partial<PrescribedSetV1>)] })).toBe("1 × 5");
  });

  it("DI-AW-002: differing or missing targets hide the summary instead of misleading", () => {
    expect(exerciseSetSummary({ sets: [set(1), set(2, { targetReps: { kind: "EXACT", reps: 6 } } as Partial<PrescribedSetV1>)] })).toBeNull();
    expect(exerciseSetSummary({ sets: [set(1, { targetReps: null })] })).toBeNull();
    expect(exerciseSetSummary({ sets: [] })).toBeNull();
  });

  it("DI-AW-003: deferred RIR / Swap / Pain never appear as controls in Active Workout", () => {
    const source = readFileSync(new URL("../../app/active-workout.tsx", import.meta.url), "utf8");
    for (const forbidden of ["RIR", "Swap", "Pain", "Why?"]) expect(source).not.toMatch(new RegExp(`["'>]${forbidden.replace("?", "\\\\?")}`));
  });

  it("DI-AW-004: the Finish sheet clears the Android navigation bar (absolute overlay adds the bottom safe-area inset)", () => {
    // Found on the Huawei P20 Pro: the overlay ignores the SafeAreaView padding, so the buttons sat under the nav bar.
    const source = readFileSync(new URL("../../app/active-workout.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/function FinishConfirmSheet[\s\S]*?useSafeAreaInsets\(\)[\s\S]*?paddingBottom: spacing\.xl \+ insets\.bottom/);
  });
});
