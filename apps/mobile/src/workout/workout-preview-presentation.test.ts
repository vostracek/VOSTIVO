import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkoutPreviewExerciseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { ExternalWeightLoad, PrescribedSetV1, WorkoutPrescriptionV1 } from "@vostivo/domain";
import { previewExerciseView, previewFooter, spokenLoad } from "./workout-preview-presentation";

const KG = (kg: number): ExternalWeightLoad => ({ kind: "EXTERNAL_WEIGHT", amountMilli: kg * 1000, unit: "KG", basis: "TOTAL" });
const RANGE = { kind: "RANGE" as const, minReps: 8, maxReps: 12 };

function benchPreview(options: { working?: ExternalWeightLoad[]; progression?: WorkoutPreviewExerciseV1["progression"]; substitution?: WorkoutPreviewExerciseV1["substitution"]; name?: string } = {}): { exercise: WorkoutPreviewExerciseV1; preview: Pick<WorkoutPreviewV1, "prescription"> } {
  const working = options.working ?? [KG(62.5), KG(62.5), KG(62.5)];
  const sets: PrescribedSetV1[] = [
    { prescriptionSetId: "s0", order: 1, targetReps: RANGE, targetLoad: KG(20), restSeconds: 90, setType: "WARM_UP" },
    ...working.map((load, i): PrescribedSetV1 => ({ prescriptionSetId: `s${i + 1}`, order: i + 2, targetReps: RANGE, targetLoad: load, restSeconds: 90, setType: "WORKING" })),
  ];
  const prescription: WorkoutPrescriptionV1 = { schemaVersion: 1, prescriptionId: "w1", name: "Upper A", exercises: [{ prescriptionExerciseId: "e1", exerciseRef: "bench-press", displayName: "Bench Press", order: 1, sets }] };
  const exercise: WorkoutPreviewExerciseV1 = {
    plannedExerciseId: "e1",
    displayName: options.name ?? "Bench Press",
    order: 1,
    sets: sets.map((set) => ({ plannedSetId: set.prescriptionSetId, order: set.order, targetReps: set.targetReps, targetLoad: set.targetLoad, restSeconds: set.restSeconds })),
    ...(options.progression === undefined ? {} : { progression: options.progression }),
    ...(options.substitution === undefined ? {} : { substitution: options.substitution }),
  };
  return { exercise, preview: { prescription } };
}

const APPLIED = { applicationId: "app-1", previousLoad: KG(60) };

describe("Workout Preview progression feedback (server provenance only)", () => {
  it("an APPLIED progression shows the effective target as primary and 'Up from' as context", () => {
    const { exercise, preview } = benchPreview({ progression: APPLIED });
    const view = previewExerciseView(exercise, preview);
    expect(view.progression).toEqual({ target: "62.5kg", upFrom: "Up from 60kg" });
    // The previous load never replaces the effective target in the set lines.
    expect(view.setLines).toEqual(["8–12 reps · 20kg", "8–12 reps · 62.5kg", "8–12 reps · 62.5kg", "8–12 reps · 62.5kg"]);
  });

  it("no provenance -> normal target only, even when loads differ from history", () => {
    const { exercise, preview } = benchPreview();
    expect(exercise.progression).toBeUndefined();
    expect(previewExerciseView(exercise, preview).progression).toBeNull();
    expect(previewExerciseView(exercise, preview).accessibilityLabel).not.toMatch(/up from/i);
  });

  it("the screen-reader label carries target + 'up from' in words (never colour alone)", () => {
    const { exercise, preview } = benchPreview({ progression: APPLIED });
    expect(previewExerciseView(exercise, preview).accessibilityLabel).toBe(
      "Bench Press, 4 sets: 8–12 reps · 20kg; 8–12 reps · 62.5kg; 8–12 reps · 62.5kg; 8–12 reps · 62.5kg. Target 62.5 kilograms, up from 60 kilograms.",
    );
  });

  it("a substitute never shows authored progression, and a non-uniform START target fails closed", () => {
    const substitution = { kind: "TEMPORARY_EQUIPMENT" as const, reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE" as const, authoredExerciseRef: "bench-press", authoredDisplayName: "Bench Press", equipmentApplicationId: "eq-1", policyVersion: "equipment-adaptation/v1" as const, catalogVersion: "exercise-equipment-catalog/v1" };
    const sub = benchPreview({ progression: APPLIED, substitution, name: "Dumbbell Bench Press" });
    expect(previewExerciseView(sub.exercise, sub.preview).progression).toBeNull();
    const mixed = benchPreview({ progression: APPLIED, working: [KG(62.5), KG(60), KG(62.5)] });
    expect(previewExerciseView(mixed.exercise, mixed.preview).progression).toBeNull();
  });

  it("other units and per-implement loads format correctly", () => {
    const lb: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 50000, unit: "LB", basis: "PER_IMPLEMENT" };
    const { exercise, preview } = benchPreview({ progression: { applicationId: "a", previousLoad: { ...lb, amountMilli: 45000 } }, working: [lb, lb] });
    expect(previewExerciseView(exercise, preview).progression).toEqual({ target: "50lb each", upFrom: "Up from 45lb each" });
    expect(spokenLoad(lb)).toBe("50 pounds each");
  });

  it("long exercise names are passed through whole (the card wraps)", () => {
    const name = "Single-Arm Half-Kneeling Landmine Press With Pause At The Bottom";
    const { exercise, preview } = benchPreview({ progression: APPLIED, name });
    expect(previewExerciseView(exercise, preview).title).toBe(name);
  });

  it("opened from Progress the Preview is read only: no Start action is wired", () => {
    const source = readFileSync(new URL("../../app/workout/[plannedWorkoutId].tsx", import.meta.url), "utf8");
    expect(source).toContain("isPreviewOnlySource(source)");
    // The Start button renders, and the handler proceeds, only for the START footer.
    expect(source).toContain('footer?.kind === "START"');
    expect(source).toContain('if (previewFooter(preview, previewOnly).kind !== "START") return;');
  });
});

describe("Workout Preview footer — completed occurrence (Slice D)", () => {
  it("31/32/34: a canonical COMPLETED occurrence is read only: 'Workout completed' + View workout of the exact canonical session, no Start", () => {
    expect(previewFooter({ displayStatus: "COMPLETED", completedWorkoutSessionId: "sess-canonical" }, false)).toEqual({
      kind: "COMPLETED",
      text: "Workout completed",
      viewWorkoutHref: "/progress/workouts/sess-canonical",
    });
  });

  it("31: completed without a server id (older server) is still read only, just without View workout", () => {
    expect(previewFooter({ displayStatus: "COMPLETED" }, false)).toEqual({ kind: "COMPLETED", text: "Workout completed", viewWorkoutHref: null });
  });

  it("31: completed wins over the Progress preview-only path too (never a Start either way)", () => {
    expect(previewFooter({ displayStatus: "COMPLETED", completedWorkoutSessionId: "s" }, true).kind).toBe("COMPLETED");
  });

  it("35: Progress '?source=progress' stays preview only for a not-yet-performed workout", () => {
    expect(previewFooter({ displayStatus: "PLANNED" }, true)).toEqual({ kind: "PREVIEW_ONLY", text: "Preview only · start this workout from Today or Plan" });
  });

  it("36: ordinary today / future / in-progress workouts keep the Start footer (in-progress resolves to Resume)", () => {
    for (const displayStatus of ["TODAY", "PLANNED", "IN_PROGRESS"] as const) expect(previewFooter({ displayStatus }, false)).toEqual({ kind: "START" });
  });

  it("33: the Preview screen has no Adjust time / Equipment / repeat actions at all", () => {
    const source = readFileSync(new URL("../../app/workout/[plannedWorkoutId].tsx", import.meta.url), "utf8");
    for (const forbidden of ["Adjust time", "AvailableTimeSheet", "EquipmentSheet", "Repeat", "Start again"]) expect(source).not.toContain(forbidden);
  });
});
