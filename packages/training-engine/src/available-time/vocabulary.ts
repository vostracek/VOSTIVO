/**
 * Available-Time Adaptation V1 (tech-lead-locked methodology,
 * `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`) — the finite, locked
 * vocabularies `./policy.ts` consumes/produces. Same plain string-literal
 * union convention as the Progression Engine's own `vocabulary.ts`.
 */

/**
 * Exactly three tiers (locked §2) — `TIER_1` highest adaptation priority /
 * most protected, `TIER_3` first reducible. Deliberately NOT
 * compound/accessory, exercise taxonomy, or a muscle category — an
 * explicit, opaque priority signal the assembler (a future slice) must
 * supply, never inferred here from `exerciseKey`/name/order.
 */
export const PRIORITY_TIERS_V1 = ["TIER_1", "TIER_2", "TIER_3"] as const;
export type PriorityTierV1 = (typeof PRIORITY_TIERS_V1)[number];

/** The reduction order sets never overturn (locked §4): TIER_3 first, TIER_1 last. */
export const TIER_REMOVAL_ORDER_V1: readonly PriorityTierV1[] = ["TIER_3", "TIER_2", "TIER_1"];

/** Locked §11 — no nullable ambiguous result; exactly these three. */
export const AVAILABLE_TIME_RESULT_KINDS_V1 = ["NO_CHANGE", "ADJUST_SESSION", "CANNOT_FIT_MINIMUM"] as const;
export type AvailableTimeResultKindV1 = (typeof AVAILABLE_TIME_RESULT_KINDS_V1)[number];

/** Closed reason vocabulary (§13/§14/§20) — never free-text/athlete-facing prose generated inside the engine. */
export const AVAILABLE_TIME_REASON_CODES_V1 = [
  "FITS_WITHOUT_CHANGE",
  "REDUCED_TO_FIT_AVAILABLE_TIME",
  "MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME",
] as const;
export type AvailableTimeReasonCodeV1 = (typeof AVAILABLE_TIME_REASON_CODES_V1)[number];
