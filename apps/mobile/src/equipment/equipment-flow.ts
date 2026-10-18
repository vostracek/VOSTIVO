import type {
  EquipmentAdaptationOptionsResponseV1,
  EquipmentAdaptationPreviewResponseV1,
  EquipmentAdaptationPreviewReviewReasonV1,
  WorkoutPreviewV1,
} from "@vostivo/contracts";
import type { RepTargetV1 } from "@vostivo/domain";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice D: the athlete-facing
 * flow as PURE state + presentation rules (no React, no I/O) — the same
 * "pure derivation, thin screen" convention as Available-Time and Missed
 * Workout. Nothing here re-implements `equipment-adaptation/v1`: options,
 * replacements, names and the effective prescription all come from the
 * server.
 *
 * - MOBILE NEVER OWNS THE CANONICAL EQUIPMENT CATALOG: the choices are the
 *   server's options response (ids + labels), never a hardcoded list.
 * - USER SELECTS THE COMPLETE AVAILABLE INVENTORY FOR THIS SESSION: the
 *   selection IS `availableEquipmentIds`; anything unselected is unavailable.
 * - Nothing is preselected on first use ("Everything available" is an
 *   explicit tap); only the athlete's own still-applicable application for
 *   today (server-stored) may seed the selection. Nothing is persisted.
 */
export type ReviewPreview<R extends EquipmentAdaptationPreviewResponseV1["result"]> = Extract<EquipmentAdaptationPreviewResponseV1, { result: R }>;

export type ApplyActionState = { readonly status: "idle" } | { readonly status: "applying" } | { readonly status: "failed" };

interface WithSelection {
  readonly options: EquipmentAdaptationOptionsResponseV1;
  /** The complete session inventory, in option order. */
  readonly selection: readonly string[];
}

export type EquipmentFlowState =
  | { readonly kind: "LOADING_OPTIONS" }
  /** Options could not be loaded (offline/5xx): small retryable error inside the sheet. */
  | { readonly kind: "OPTIONS_ERROR" }
  | { readonly kind: "TIMEZONE_REQUIRED"; readonly retrying: boolean }
  | (WithSelection & {
      readonly kind: "SELECTING";
      readonly previewing: boolean;
      /** The last "Review changes" failed (network/5xx) — selection kept, retryable. */
      readonly previewFailed: boolean;
      /** The server's catalog changed under the sheet: options reloaded, selection kept where still valid. */
      readonly catalogRefreshed: boolean;
    })
  | (WithSelection & {
      readonly kind: "ADJUST_SESSION";
      readonly preview: ReviewPreview<"ADJUST_SESSION">;
      readonly apply: ApplyActionState;
      /** A previous Apply went STALE and this is the re-derived recommendation — a new explicit Apply is required. */
      readonly workoutChanged: boolean;
    })
  | (WithSelection & {
      readonly kind: "NO_CHANGE";
      readonly preview: ReviewPreview<"NO_CHANGE">;
      /** The server's effective Workout Preview currently carries a temporary equipment substitution -> offer the explicit clear. */
      readonly currentlyAdjusted: boolean;
      readonly apply: ApplyActionState;
      readonly workoutChanged: boolean;
    })
  | (WithSelection & { readonly kind: "REVIEW_REQUIRED"; readonly preview: ReviewPreview<"REVIEW_REQUIRED">; readonly workoutChanged: boolean });

export const INITIAL_EQUIPMENT_FLOW_STATE: EquipmentFlowState = { kind: "LOADING_OPTIONS" };

export const EQUIPMENT_COPY = {
  todayAction: "Equipment",
  eyebrow: "EQUIPMENT",
  selectTitle: "Equipment available today",
  selectBody: "Select what you can use for this workout.",
  selectHint: "Anything not selected counts as unavailable for this session.",
  everythingAvailable: "Everything available",
  clearAll: "Clear all",
  reviewChanges: "Review changes",
  reviewing: "Reviewing…",
  optionsError: "Couldn't load equipment right now.",
  previewError: "Couldn't review the workout right now.",
  catalogRefreshed: "The equipment list was updated. Review your selection.",
  retry: "Retry",
  adjustTitle: "Adjust this workout",
  adjustEyebrow: "EQUIPMENT UPDATE",
  replacementReason: "Equipment unavailable today",
  preserved: "Sets, reps and rest stay the same.",
  loadResolved: "Load is resolved for the replacement.",
  apply: "Apply changes",
  applying: "Applying…",
  notNow: "Not now",
  applyFailed: "Couldn't update the workout right now.",
  workoutChanged: "Workout changed. Review the updated recommendation.",
  noChangeTitle: "No changes needed",
  noChangeBody: "This workout fits the equipment you selected.",
  done: "Done",
  useOriginal: "Use original workout",
  useOriginalBody: "Your original exercises come back for today.",
  reviewRequiredTitle: "This workout needs review",
  editEquipment: "Edit equipment",
  timeZoneRequired: "Set your training timezone to adjust equipment.",
  tryAgain: "Try again",
} as const;

/** Only the athlete's own still-applicable application for today may seed the sheet — limited to ids still offered. Otherwise nothing is selected. */
export function initialSelection(options: EquipmentAdaptationOptionsResponseV1): readonly string[] {
  const stored = new Set(options.currentApplication?.availableEquipmentIds ?? []);
  return options.equipmentOptions.filter((o) => stored.has(o.equipmentId)).map((o) => o.equipmentId);
}

/** Toggle one offered id; the result stays in option order (unknown ids are ignored). */
export function toggleEquipment(options: EquipmentAdaptationOptionsResponseV1, selection: readonly string[], equipmentId: string): readonly string[] {
  const selected = new Set(selection);
  if (selected.has(equipmentId)) selected.delete(equipmentId);
  else selected.add(equipmentId);
  return options.equipmentOptions.filter((o) => selected.has(o.equipmentId)).map((o) => o.equipmentId);
}

/** "Everything available" — an EXPLICIT athlete decision: exactly every offered id. */
export function selectAllEquipment(options: EquipmentAdaptationOptionsResponseV1): readonly string[] {
  return options.equipmentOptions.map((o) => o.equipmentId);
}

/** After a catalog refresh: keep only ids the new options still offer. */
export function retainValidSelection(options: EquipmentAdaptationOptionsResponseV1, selection: readonly string[]): readonly string[] {
  const selected = new Set(selection);
  return options.equipmentOptions.filter((o) => selected.has(o.equipmentId)).map((o) => o.equipmentId);
}

export interface ReplacementRow {
  readonly plannedExerciseId: string;
  readonly authoredName: string;
  readonly substituteName: string;
  /** e.g. "3 × 8–12 stays the same" — from the server's preserved working prescription only. */
  readonly prescriptionLine: string;
}

/** CHANGES ONLY, authored order, server names — never the whole workout, never a load. */
export function replacementRows(preview: ReviewPreview<"ADJUST_SESSION">): readonly ReplacementRow[] {
  return [...preview.replacements]
    .sort((a, b) => a.order - b.order)
    .map((r) => ({
      plannedExerciseId: r.plannedExerciseId,
      authoredName: r.authoredExerciseName,
      substituteName: r.substituteExerciseName,
      prescriptionLine: prescriptionLine(r.prescription.workingSetCount, r.prescription.sets.filter((s) => s.setType === "WORKING").map((s) => s.targetReps)),
    }));
}

function prescriptionLine(workingSetCount: number, workingTargets: readonly (RepTargetV1 | null)[]): string {
  const first = workingTargets[0] ?? null;
  const uniform = first !== null && workingTargets.every((t) => t !== null && JSON.stringify(t) === JSON.stringify(first));
  if (!uniform) return `${workingSetCount} working ${workingSetCount === 1 ? "set" : "sets"} stay the same`;
  const reps = first.kind === "EXACT" ? `${first.reps}` : `${first.minReps}–${first.maxReps}`;
  return `${workingSetCount} × ${reps} stays the same`;
}

/** A calm, user-level reason; never the raw code. */
export function reviewRequiredMessage(reasonCode: EquipmentAdaptationPreviewReviewReasonV1): string {
  switch (reasonCode) {
    case "NO_CURATED_SUBSTITUTE":
    case "NO_AVAILABLE_SUBSTITUTE":
    case "NO_EQUIVALENT_SUBSTITUTE":
      return "No automatic substitute fits the equipment you selected.";
    case "UNSUPPORTED_EXERCISE_IDENTITY":
      return "One exercise can't be adjusted automatically.";
    case "LOCKED_EXERCISE_UNAVAILABLE":
      return "This exercise is fixed in your plan.";
    case "AMBIGUOUS_SUBSTITUTION":
    case "SUBSTITUTE_CONFLICT":
      return "Vostivo found more than one safe path and won't choose for you.";
    case "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY":
      return "One exercise can't keep its sets and reps with the equipment you selected.";
  }
}

/** Exercises of the server's EFFECTIVE Workout Preview currently replaced by a temporary equipment substitution. */
export function equipmentAdjustedCount(workoutPreview: Pick<WorkoutPreviewV1, "prescription">): number {
  return workoutPreview.prescription.exercises.filter((e) => e.substitution?.kind === "TEMPORARY_EQUIPMENT").length;
}

/** Today's quiet, informational line — `null` renders nothing. */
export function equipmentAdjustedLabel(count: number): string | null {
  if (count <= 0) return null;
  return `Equipment adjusted · ${count} ${count === 1 ? "exercise" : "exercises"}`;
}
