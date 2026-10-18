import { describe, expect, it } from "vitest";
import { PLANNED_EXERCISE_PRIORITY_TIER_VALUES } from "@vostivo/database";
import { PRIORITY_TIERS_V1, availableTimePolicyV1, estimateExerciseDurationSeconds } from "@vostivo/training-engine";
import {
  AVAILABLE_TIME_POLICY_VERSION,
  computeAvailableTimePreview,
  computeAvailableTimePreviewFingerprint,
  normalizeAvailableTimeInput,
  type AvailableTimeExerciseRow,
  type AvailableTimePreviewSource,
} from "./available-time-preview.js";

/**
 * Available-Time Adaptation V1 — Slice B: the pure normalization/
 * fingerprint half of the server preview. DB round-trip, BOLA, the
 * workout-state guard and "zero mutations" are covered against real
 * Postgres in available-time-preview.integration.test.ts.
 */

function workingSets(exerciseId: string, count: number, restSeconds: number | null = 90): AvailableTimeExerciseRow["sets"] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${exerciseId}-s${index + 1}`,
    orderIndex: index + 1,
    setType: "WORKING" as const,
    restSeconds,
  }));
}

/** The tech-lead manual fixture shape (Slice B §14): Bench TIER_1/min 2 x3, OHP TIER_2/min 0 x2, 90s rest. */
function fixtureExercises(): AvailableTimeExerciseRow[] {
  return [
    { id: "bench", exerciseRef: "bench-press", displayName: "Bench Press", orderIndex: 1, priorityTier: "TIER_1", minimumWorkingSets: 2, sets: workingSets("bench", 3) },
    { id: "ohp", exerciseRef: "overhead-press", displayName: "Overhead Press", orderIndex: 2, priorityTier: "TIER_2", minimumWorkingSets: 0, sets: workingSets("ohp", 2) },
  ];
}

function source(overrides: Partial<AvailableTimePreviewSource> = {}): AvailableTimePreviewSource {
  return { plannedWorkoutId: "workout-1", programVersionId: "version-1", availableMinutes: 9, exercises: fixtureExercises(), ...overrides };
}

describe("Available-Time preview — vocabulary locks", () => {
  it("the persisted tier enum is exactly the engine's PRIORITY_TIERS_V1", () => {
    expect([...PLANNED_EXERCISE_PRIORITY_TIER_VALUES]).toEqual([...PRIORITY_TIERS_V1]);
  });

  it("policyVersion is the engine's own `${engine}/${policy}`", () => {
    expect(AVAILABLE_TIME_POLICY_VERSION).toBe(`${availableTimePolicyV1.version.engine}/${availableTimePolicyV1.version.policy}`);
  });
});

describe("normalizeAvailableTimeInput — canonical rows -> available-time/v1 input", () => {
  it("preserves explicit priorityTier and minimumWorkingSets exactly", () => {
    const result = normalizeAvailableTimeInput(fixtureExercises(), 540);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exercises.map((e) => [e.exerciseKey, e.priorityTier, e.minimumWorkingSets])).toEqual([
      ["bench", "TIER_1", 2],
      ["ohp", "TIER_2", 0],
    ]);
  });

  it("keeps the WORKING / WARM_UP distinction per set", () => {
    const exercises: AvailableTimeExerciseRow[] = [
      {
        ...fixtureExercises()[0]!,
        sets: [
          { id: "w1", orderIndex: 1, setType: "WARM_UP", restSeconds: 60 },
          { id: "s1", orderIndex: 2, setType: "WORKING", restSeconds: 90 },
          { id: "s2", orderIndex: 3, setType: "WORKING", restSeconds: 90 },
        ],
      },
    ];
    const result = normalizeAvailableTimeInput(exercises, 600);
    expect(result.ok && result.value.exercises[0]!.sets.map((s) => [s.setKey, s.setType])).toEqual([
      ["w1", "WARM_UP"],
      ["s1", "WORKING"],
      ["s2", "WORKING"],
    ]);
  });

  it("orders exercises and sets by authored orderIndex, whatever order the rows arrive in", () => {
    const [bench, ohp] = fixtureExercises();
    const shuffled: AvailableTimeExerciseRow[] = [{ ...ohp!, sets: [...ohp!.sets].reverse() }, { ...bench!, sets: [...bench!.sets].reverse() }];
    const result = normalizeAvailableTimeInput(shuffled, 540);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exercises.map((e) => e.exerciseKey)).toEqual(["bench", "ohp"]);
    expect(result.value.exercises[0]!.sets.map((s) => s.setKey)).toEqual(["bench-s1", "bench-s2", "bench-s3"]);
  });

  it("fails closed on a missing priorityTier (never inferred from name/order)", () => {
    const exercises = fixtureExercises();
    exercises[1] = { ...exercises[1]!, priorityTier: null };
    expect(normalizeAvailableTimeInput(exercises, 540)).toEqual({ ok: false, error: { code: "AVAILABLE_TIME_PRIORITY_TIER_MISSING", plannedExerciseId: "ohp" } });
  });

  it("fails closed on a missing minimumWorkingSets", () => {
    const exercises = fixtureExercises();
    exercises[0] = { ...exercises[0]!, minimumWorkingSets: null };
    expect(normalizeAvailableTimeInput(exercises, 540)).toEqual({ ok: false, error: { code: "AVAILABLE_TIME_MINIMUM_WORKING_SETS_MISSING", plannedExerciseId: "bench" } });
  });

  it("fails closed on a missing rest that a reduction outcome would need", () => {
    const exercises = fixtureExercises();
    exercises[0] = { ...exercises[0]!, sets: exercises[0]!.sets.map((s, i) => (i === 0 ? { ...s, restSeconds: null } : s)) };
    expect(normalizeAvailableTimeInput(exercises, 540)).toEqual({ ok: false, error: { code: "AVAILABLE_TIME_REST_SECONDS_MISSING", plannedSetId: "bench-s1" } });
  });

  it("a NULL rest on an exercise's last authored set is never read by the policy, so it does not block — and adds no time", () => {
    const exercises = fixtureExercises();
    const benchSets = workingSets("bench", 3);
    exercises[0] = { ...exercises[0]!, sets: [...benchSets.slice(0, 2), { ...benchSets[2]!, restSeconds: null }] };
    const result = normalizeAvailableTimeInput(exercises, 540);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(estimateExerciseDurationSeconds(result.value.exercises[0]!.sets)).toBe(60 + 3 * 30 + 2 * 90);
  });
});

describe("computeAvailableTimePreview — engine validation still fails closed", () => {
  it("minimumWorkingSets above the authored WORKING set count is invalid structure", () => {
    const exercises = fixtureExercises();
    exercises[0] = { ...exercises[0]!, minimumWorkingSets: 4 };
    expect(computeAvailableTimePreview(source({ exercises }))).toEqual({
      ok: false,
      error: { code: "AVAILABLE_TIME_STRUCTURE_INVALID", reason: "MINIMUM_EXCEEDS_WORKING_SET_COUNT" },
    });
  });

  it("a negative minimumWorkingSets is invalid structure (the DB CHECK is not the only guard)", () => {
    const exercises = fixtureExercises();
    exercises[1] = { ...exercises[1]!, minimumWorkingSets: -1 };
    expect(computeAvailableTimePreview(source({ exercises }))).toEqual({
      ok: false,
      error: { code: "AVAILABLE_TIME_STRUCTURE_INVALID", reason: "NEGATIVE_MINIMUM_WORKING_SETS" },
    });
  });

  it("at least one exercise must have minimumWorkingSets > 0", () => {
    const exercises = fixtureExercises().map((e) => ({ ...e, minimumWorkingSets: 0 }));
    expect(computeAvailableTimePreview(source({ exercises }))).toEqual({
      ok: false,
      error: { code: "AVAILABLE_TIME_STRUCTURE_INVALID", reason: "NO_EXERCISE_WITH_POSITIVE_MINIMUM" },
    });
  });

  it("a workout with no exercises is invalid structure, never NO_CHANGE", () => {
    expect(computeAvailableTimePreview(source({ exercises: [] }))).toEqual({
      ok: false,
      error: { code: "AVAILABLE_TIME_STRUCTURE_INVALID", reason: "NO_EXERCISES" },
    });
  });

  it("warm-ups count toward total sets and are retained with their exercise", () => {
    const exercises = fixtureExercises();
    exercises[0] = {
      ...exercises[0]!,
      sets: [{ id: "bench-w1", orderIndex: 0, setType: "WARM_UP", restSeconds: 60 }, ...workingSets("bench", 3)],
    };
    // Full: bench 60+4*30+60+90+90 = 420, ohp 210 -> 630s. 5 min (300s)
    // removes both OHP sets then bench set 3 -> bench 60+3*30+60+90 = 300.
    const result = computeAvailableTimePreview(source({ exercises, availableMinutes: 5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe("ADJUST_SESSION");
    expect(result.value.exercises[0]).toMatchObject({ originalTotalSetCount: 4, retainedTotalSetCount: 3, originalWorkingSetCount: 3, retainedWorkingSetCount: 2 });
  });
});

describe("previewFingerprint — deterministic stale-input guard", () => {
  function fingerprint(s: AvailableTimePreviewSource): string {
    return computeAvailableTimePreviewFingerprint(s);
  }

  it("identical input gives an identical fingerprint, independent of row order", () => {
    const shuffled = [...fixtureExercises()].reverse();
    expect(fingerprint(source())).toBe(fingerprint(source()));
    expect(fingerprint(source({ exercises: shuffled }))).toBe(fingerprint(source()));
    expect(fingerprint(source())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["availableMinutes", source({ availableMinutes: 8 })],
    ["plannedWorkoutId", source({ plannedWorkoutId: "workout-2" })],
    ["programVersionId", source({ programVersionId: "version-2" })],
    ["priorityTier", source({ exercises: fixtureExercises().map((e, i) => (i === 1 ? { ...e, priorityTier: "TIER_3" } : e)) })],
    ["minimumWorkingSets", source({ exercises: fixtureExercises().map((e, i) => (i === 0 ? { ...e, minimumWorkingSets: 1 } : e)) })],
    ["restSeconds", source({ exercises: fixtureExercises().map((e, i) => (i === 0 ? { ...e, sets: workingSets("bench", 3, 120) } : e)) })],
    ["set count", source({ exercises: fixtureExercises().map((e, i) => (i === 0 ? { ...e, sets: workingSets("bench", 4) } : e)) })],
    ["set type", source({ exercises: fixtureExercises().map((e, i) => (i === 0 ? { ...e, sets: e.sets.map((s, j) => (j === 0 ? { ...s, setType: "WARM_UP" as const } : s)) } : e)) })],
  ])("changes when %s changes", (_label, changed) => {
    expect(fingerprint(changed)).not.toBe(fingerprint(source()));
  });
});

describe("exact structural identity (Slice C)", () => {
  function preview(availableMinutes: number, exercises = fixtureExercises()) {
    const result = computeAvailableTimePreview(source({ availableMinutes, exercises }));
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    return result.value;
  }

  it("NO_CHANGE: every set retained, removedPlannedSetIds = []", () => {
    expect(preview(9).exercises.map((e) => [e.retainedPlannedSetIds, e.removedPlannedSetIds])).toEqual([
      [["bench-s1", "bench-s2", "bench-s3"], []],
      [["ohp-s1", "ohp-s2"], []],
    ]);
  });

  it("whole-exercise removal: retainedPlannedSetIds = []", () => {
    expect(preview(6).exercises[1]).toMatchObject({ removedEntireExercise: true, retainedPlannedSetIds: [], removedPlannedSetIds: ["ohp-s1", "ohp-s2"] });
  });

  it("CANNOT_FIT_MINIMUM exposes the exact structural minimum", () => {
    const result = preview(3);
    expect(result.result).toBe("CANNOT_FIT_MINIMUM");
    expect(result.exercises.map((e) => [e.retainedPlannedSetIds, e.removedPlannedSetIds])).toEqual([
      [["bench-s1", "bench-s2"], ["bench-s3"]],
      [[], ["ohp-s1", "ohp-s2"]],
    ]);
  });

  it("warm-ups appear in the arrays with canonical authored order, independent of row order", () => {
    const exercises = fixtureExercises();
    exercises[0] = {
      ...exercises[0]!,
      sets: [...workingSets("bench", 3)].reverse().concat([{ id: "bench-w1", orderIndex: 0, setType: "WARM_UP", restSeconds: 60 }]),
    };
    const bench = preview(5, exercises).exercises[0]!;
    expect(bench.retainedPlannedSetIds).toEqual(["bench-w1", "bench-s1", "bench-s2"]);
    expect(bench.removedPlannedSetIds).toEqual(["bench-s3"]);
  });

  it("the ids never change the established result semantics (counts derive from the same partition)", () => {
    for (const minutes of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const exercise of preview(minutes).exercises) {
        expect(exercise.retainedTotalSetCount).toBe(exercise.retainedPlannedSetIds.length);
        expect(exercise.originalTotalSetCount - exercise.retainedTotalSetCount).toBe(exercise.removedPlannedSetIds.length);
        expect(new Set([...exercise.retainedPlannedSetIds, ...exercise.removedPlannedSetIds]).size).toBe(exercise.originalTotalSetCount);
      }
    }
  });

  it("carries the source ProgramVersion id", () => {
    expect(preview(9).sourceProgramVersionId).toBe("version-1");
  });
});

