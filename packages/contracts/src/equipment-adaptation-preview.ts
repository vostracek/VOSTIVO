import type { RepTargetV1, SetType } from "@vostivo/domain";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice B: the READ-ONLY server
 * preview (`POST /api/v1/plan/equipment-adaptation-preview`,
 * docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md §11).
 *
 * The client sends ONLY the target workout identity, the catalog version it
 * was built against, and the COMPLETE equipment inventory for THIS session.
 * Exercise requirements, substitution candidates, tiers, priorities, names,
 * prescriptions, locks, blocks, the date and the athlete are server-owned —
 * there is deliberately no field for any of them. Structured facts only, no
 * UI prose.
 */
export const EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1 = "equipment-adaptation-preview/v1" as const;

export interface EquipmentAdaptationPreviewRequestV1 {
  readonly plannedWorkoutId: string;
  /** Must equal the server's canonical catalog version (`exercise-equipment-catalog/v1`), else 409 EQUIPMENT_CATALOG_VERSION_MISMATCH. */
  readonly catalogVersion: string;
  /** The COMPLETE equipment available for this session (canonical ids). Anything not listed is unavailable. `[]` is valid. */
  readonly availableEquipmentIds: readonly string[];
}

export type EquipmentAdaptationPreviewReviewReasonV1 =
  | "UNSUPPORTED_EXERCISE_IDENTITY"
  | "LOCKED_EXERCISE_UNAVAILABLE"
  | "NO_CURATED_SUBSTITUTE"
  | "NO_AVAILABLE_SUBSTITUTE"
  | "NO_EQUIVALENT_SUBSTITUTE"
  | "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY"
  | "SUBSTITUTE_CONFLICT"
  | "AMBIGUOUS_SUBSTITUTION";

interface EquipmentAdaptationPreviewCommonV1 {
  readonly schemaVersion: typeof EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1;
  readonly policyVersion: "equipment-adaptation/v1";
  readonly catalogVersion: string;
  /** The athlete's training-time-zone calendar day the preview is for (server-resolved). */
  readonly athleteLocalDate: string;
  readonly plannedWorkoutId: string;
  readonly workoutName: string;
  /** Canonical (deduplicated, sorted) inventory the preview was evaluated against. */
  readonly availableEquipmentIds: readonly string[];
  /** Deterministic stale-input guard for a later application step — never an auth token. */
  readonly previewFingerprint: string;
}

/** Structure only — there is deliberately NO load field: the substitute's load is re-resolved for its own identity. */
export interface EquipmentAdaptationPreviewSetV1 {
  readonly plannedSetId: string;
  readonly order: number;
  readonly setType: SetType;
  readonly targetReps: RepTargetV1 | null;
  readonly restSeconds: number | null;
}

export interface EquipmentAdaptationPreviewReplacementV1 {
  readonly plannedExerciseId: string;
  /** Authored position — the substitute takes exactly this slot. */
  readonly order: number;
  readonly authoredExerciseRef: string;
  readonly authoredExerciseName: string;
  readonly substituteExerciseRef: string;
  readonly substituteExerciseName: string;
  readonly reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE";
  readonly prescriptionPolicy: "PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD";
  readonly prescription: {
    readonly workingSetCount: number;
    readonly sets: readonly EquipmentAdaptationPreviewSetV1[];
    readonly availableTime: { readonly priorityTier: "TIER_1" | "TIER_2" | "TIER_3"; readonly minimumWorkingSets: number } | null;
    /** Always: load (working and warm-up) must be re-resolved for the SUBSTITUTE — never copied or converted. */
    readonly loadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE";
  };
}

export interface EquipmentAdaptationPreviewUnresolvedV1 {
  readonly plannedExerciseId: string;
  readonly order: number;
  /** `null` = the exercise has no catalog identity at all. */
  readonly authoredExerciseRef: string | null;
  readonly authoredExerciseName: string;
  readonly reasonCode: EquipmentAdaptationPreviewReviewReasonV1;
}

export type EquipmentAdaptationPreviewResponseV1 = EquipmentAdaptationPreviewCommonV1 &
  (
    | { readonly result: "NO_CHANGE"; readonly reasonCode: "ALL_EQUIPMENT_AVAILABLE"; readonly replacements: readonly [] }
    | { readonly result: "ADJUST_SESSION"; readonly reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE"; readonly replacements: readonly EquipmentAdaptationPreviewReplacementV1[] }
    | {
        readonly result: "REVIEW_REQUIRED";
        /** The first unresolved exercise's reason, in authored order. */
        readonly reasonCode: EquipmentAdaptationPreviewReviewReasonV1;
        /** Never partial replacements — only what blocks an automatic adjustment, authored order. */
        readonly unresolved: readonly EquipmentAdaptationPreviewUnresolvedV1[];
      }
  );

/** 409 body when the target workout is not today's pre-start effective workout. */
export interface EquipmentAdaptationNotApplicableErrorV1 {
  readonly statusCode: 409;
  readonly message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE";
  readonly reasonCode: "SCHEDULE_CONTEXT_UNRESOLVED" | "OUTSIDE_CURRENT_BLOCK" | "NOT_TODAYS_WORKOUT" | "WORKOUT_RESOLVED" | "WORKOUT_ALREADY_STARTED";
}

/**
 * Temporary Equipment V1 — Slice C: durable TODAY_ONLY application
 * (`POST /api/v1/plan/equipment-adaptation-apply`). PREVIEW IS NOT
 * AUTHORITY: the client references the preview by its fingerprint and
 * re-sends only the session inventory it declared (an input, not a derived
 * fact — there is no server-side preview store or Gym Profile to read it
 * from); the server re-derives the whole adaptation from canonical current
 * state and applies only if the fingerprint still matches. Replacements,
 * candidates, names, sets, loads, locks, blocks, the date, the time zone and
 * the athlete are never accepted.
 */
export interface EquipmentAdaptationApplyRequestV1 {
  readonly plannedWorkoutId: string;
  readonly previewFingerprint: string;
  readonly catalogVersion: string;
  readonly availableEquipmentIds: readonly string[];
}

export interface EquipmentAdaptationApplyResponseV1 {
  readonly applicationId: string;
  readonly scope: "TODAY_ONLY";
  readonly plannedWorkoutId: string;
  readonly athleteLocalDate: string;
  readonly previewFingerprint: string;
  /** ACTIVE = today's effective equipment adaptation; SUPERSEDED/CONSUMED only on an idempotent retry. */
  readonly status: "ACTIVE" | "SUPERSEDED" | "CONSUMED";
  readonly result: "NO_CHANGE" | "ADJUST_SESSION";
  readonly replacements: readonly {
    readonly plannedExerciseId: string;
    readonly order: number;
    readonly authoredExerciseRef: string;
    readonly substituteExerciseRef: string;
    readonly substituteExerciseName: string;
  }[];
  /** ISO-8601 instant. */
  readonly appliedAt: string;
}

/** 409 when the current re-derived preview no longer matches the submitted fingerprint — request a fresh preview. */
export interface EquipmentAdaptationPreviewStaleErrorV1 {
  readonly statusCode: 409;
  readonly message: "EQUIPMENT_PREVIEW_STALE";
}

/** 409 when the current preview is REVIEW_REQUIRED — nothing can be applied automatically. */
export interface EquipmentAdaptationReviewRequiredErrorV1 {
  readonly statusCode: 409;
  readonly message: "EQUIPMENT_ADAPTATION_REVIEW_REQUIRED";
  readonly reasonCode: EquipmentAdaptationPreviewReviewReasonV1;
}

/**
 * Temporary Equipment V1 — Slice D: the decision-relevant equipment choices
 * for one of today's workouts (`GET /api/v1/plan/equipment-adaptation-options
 * ?plannedWorkoutId=`). MOBILE NEVER OWNS THE CANONICAL EQUIPMENT CATALOG:
 * ids and labels come from the server's catalog. Only equipment that can
 * change this workout's adaptation is listed — the requirements of its
 * planned exercises and of their curated substitutes — never candidates,
 * tiers or ranking. Same applicability as the preview (409/404 semantics).
 */
export const EQUIPMENT_ADAPTATION_OPTIONS_SCHEMA_V1 = "equipment-adaptation-options/v1" as const;

/** PLANNED = required by a planned exercise (wins when both); SUBSTITUTE = required only by a curated substitute. */
export type EquipmentAdaptationOptionRelevanceV1 = "PLANNED" | "SUBSTITUTE";

export interface EquipmentAdaptationOptionV1 {
  readonly equipmentId: string;
  readonly displayLabel: string;
  readonly relevance: EquipmentAdaptationOptionRelevanceV1;
}

export interface EquipmentAdaptationOptionsResponseV1 {
  readonly schemaVersion: typeof EQUIPMENT_ADAPTATION_OPTIONS_SCHEMA_V1;
  readonly catalogVersion: string;
  readonly plannedWorkoutId: string;
  readonly athleteLocalDate: string;
  /** Deterministic: PLANNED first, then SUBSTITUTE, each in catalog order. No duplicates. */
  readonly equipmentOptions: readonly EquipmentAdaptationOptionV1[];
  /**
   * Today's still-applicable ACTIVE application (its declared session
   * inventory, as durably stored), so the sheet can start from the athlete's
   * own earlier declaration — `null` when there is none (start empty).
   */
  readonly currentApplication: {
    readonly applicationId: string;
    readonly result: "NO_CHANGE" | "ADJUST_SESSION";
    readonly availableEquipmentIds: readonly string[];
  } | null;
}
