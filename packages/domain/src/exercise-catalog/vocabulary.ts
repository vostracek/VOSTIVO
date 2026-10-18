/**
 * Exercise & Equipment Reference Catalog V1 — the closed substitution
 * vocabulary (docs/domain/EXERCISE-EQUIPMENT-REFERENCE-CATALOG-V1.md).
 * Defined HERE (domain) so both the catalog data and the
 * `equipment-adaptation/v1` engine (training-engine depends on domain, never
 * the reverse) share one definition — never two parallel enums.
 */
export const EXERCISE_EQUIPMENT_CATALOG_VERSION_V1 = "exercise-equipment-catalog/v1" as const;

/**
 * - ROLE_EQUIVALENT: CURATED, never inferred — for the intended Vostivo
 *   strength/hypertrophy programming role the substitute is close enough that
 *   the working prescription may be preserved while load is re-resolved
 *   independently. NOT identical biomechanics, strength numbers, history or
 *   exercise. The only tier `equipment-adaptation/v1` may auto-select.
 * - ROLE_COMPATIBLE: a broadly suitable alternative for future review/manual
 *   selection — never auto-selected, never promoted for lack of an
 *   equivalent.
 */
export const SUBSTITUTE_COMPATIBILITY_TIERS_V1 = ["ROLE_EQUIVALENT", "ROLE_COMPATIBLE"] as const;
export type SubstituteCompatibilityTierV1 = (typeof SUBSTITUTE_COMPATIBILITY_TIERS_V1)[number];

/** Whether the authored WORKING prescription may be kept for the substitute. Load is NEVER part of it (no conversion data exists anywhere). */
export const PRESCRIPTION_COMPATIBILITIES_V1 = ["PRESERVE_WORKING_PRESCRIPTION", "REQUIRES_PRESCRIPTION_CHANGE"] as const;
export type PrescriptionCompatibilityV1 = (typeof PRESCRIPTION_COMPATIBILITIES_V1)[number];
