import type { ExerciseIdentityV1, RepTargetV1, SetType } from "@vostivo/domain";
import type { PriorityTierV1 } from "../available-time/vocabulary.js";
import type { EquipmentAdaptationReviewReasonV1, PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD } from "./vocabulary.js";

/** A preserved set: structure only. There is deliberately NO load field — the substitute's load is resolved later from ITS OWN history. */
export interface PreservedSetV1 {
  readonly plannedSetId: string;
  readonly order: number;
  readonly setType: SetType;
  readonly targetReps: RepTargetV1 | null;
  readonly restSeconds: number | null;
}

export interface PreservedPrescriptionV1 {
  readonly policy: typeof PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD;
  readonly workingSetCount: number;
  readonly sets: readonly PreservedSetV1[];
  /** Carried through unchanged; never used for ranking. */
  readonly availableTime: { readonly priorityTier: PriorityTierV1; readonly minimumWorkingSets: number } | null;
  /** Always: every working set's load must be resolved for the SUBSTITUTE exercise (history / Load Resolver / increments / no-history flow). */
  readonly workingLoadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE";
  /** Warm-up structure is kept, its load is never copied; `null` when there are no warm-up sets. */
  readonly warmUpLoadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE" | null;
}

export interface EquipmentReplacementV1 {
  readonly plannedExerciseId: string;
  /** The authored intent — unchanged. */
  readonly authoredExerciseId: ExerciseIdentityV1;
  /** What will actually be performed — performance history belongs to THIS identity. */
  readonly substituteExerciseId: ExerciseIdentityV1;
  /** The authored position the substitute occupies (never reordered). */
  readonly order: number;
  readonly reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE";
  readonly prescription: PreservedPrescriptionV1;
}

/** Canonical session identity after the decision (for later preview/fingerprint): authored order, unaffected slots untouched. */
export interface SessionExerciseSlotV1 {
  readonly plannedExerciseId: string;
  readonly order: number;
  readonly authoredExerciseId: ExerciseIdentityV1;
  /** === authoredExerciseId unless substituted. */
  readonly effectiveExerciseId: ExerciseIdentityV1;
  readonly substituted: boolean;
}

export interface UnresolvedExerciseV1 {
  readonly plannedExerciseId: string;
  readonly authoredExerciseId: ExerciseIdentityV1;
  readonly reasonCode: EquipmentAdaptationReviewReasonV1;
}

export type EquipmentAdaptationDecisionDataV1 =
  | { readonly resultKind: "NO_CHANGE"; readonly reasonCode: "ALL_EQUIPMENT_AVAILABLE" }
  | {
      readonly resultKind: "ADJUST_SESSION";
      readonly reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE";
      /** Only the affected exercises, in authored order — the smallest replacement diff. */
      readonly replacements: readonly EquipmentReplacementV1[];
      readonly session: readonly SessionExerciseSlotV1[];
    }
  | {
      readonly resultKind: "REVIEW_REQUIRED";
      /** The first unresolved exercise's reason (authored order). */
      readonly reasonCode: EquipmentAdaptationReviewReasonV1;
      /** Every unavailable exercise that could not be resolved automatically, authored order. NO partial replacements are returned. */
      readonly unresolved: readonly UnresolvedExerciseV1[];
      /** Every unavailable exercise (resolved or not), authored order. */
      readonly unavailablePlannedExerciseIds: readonly string[];
    };
