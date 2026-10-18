/**
 * Temporary Equipment / Gym Adaptation V1 — closed vocabularies
 * (docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md). Reason codes are
 * stable business identifiers, never prose.
 */
export const EQUIPMENT_ADAPTATION_POLICY_VERSION_V1 = "equipment-adaptation/v1" as const;

/**
 * The curated substitution vocabulary is defined ONCE, with the canonical
 * Exercise & Equipment Reference Catalog V1 in `@vostivo/domain`
 * (docs/domain/EXERCISE-EQUIPMENT-REFERENCE-CATALOG-V1.md), and re-exported
 * here unchanged under the same names — catalog data and this policy can
 * never drift apart.
 * - ROLE_EQUIVALENT: the only tier V1 may recommend automatically.
 * - ROLE_COMPATIBLE: never auto-selected in V1.
 * - Prescription compatibility never includes load.
 */
export {
  PRESCRIPTION_COMPATIBILITIES_V1,
  SUBSTITUTE_COMPATIBILITY_TIERS_V1,
  type PrescriptionCompatibilityV1,
  type SubstituteCompatibilityTierV1,
} from "@vostivo/domain";

/** A program/coach lock: LOCKED exercises are never substituted automatically. */
export const SUBSTITUTION_POLICIES_V1 = ["ALLOW_TEMPORARY", "LOCKED"] as const;
export type SubstitutionPolicyV1 = (typeof SUBSTITUTION_POLICIES_V1)[number];

export const EQUIPMENT_ADAPTATION_RESULT_KINDS_V1 = ["NO_CHANGE", "ADJUST_SESSION", "REVIEW_REQUIRED"] as const;
export type EquipmentAdaptationResultKindV1 = (typeof EQUIPMENT_ADAPTATION_RESULT_KINDS_V1)[number];

/** Per unavailable exercise; checked in this fixed order (see policy.ts). */
export const EQUIPMENT_ADAPTATION_REVIEW_REASONS_V1 = [
  "LOCKED_EXERCISE_UNAVAILABLE",
  "NO_CURATED_SUBSTITUTE",
  "NO_AVAILABLE_SUBSTITUTE",
  "NO_EQUIVALENT_SUBSTITUTE",
  "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY",
  "SUBSTITUTE_CONFLICT",
  "AMBIGUOUS_SUBSTITUTION",
] as const;
export type EquipmentAdaptationReviewReasonV1 = (typeof EQUIPMENT_ADAPTATION_REVIEW_REASONS_V1)[number];

export const PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD = "PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD" as const;
