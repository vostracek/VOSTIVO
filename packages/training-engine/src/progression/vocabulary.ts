/**
 * Pure Progression Engine V1 (docs/domain/PROGRESSION-ENGINE-V1.md §13/
 * §10.1/§17) — the finite, locked vocabularies the policy in
 * `./policy.ts` consumes/produces. Kept as plain string-literal unions
 * (matching `@vostivo/domain`'s `SetType`/`LoadUnit`/... convention),
 * never free-form strings, so an invalid value is a compile-time error
 * for callers and a trivial runtime membership check here.
 */

/**
 * Exactly three decision types (§13, tech-lead-locked) — no `DELOAD`,
 * `REDUCE_VOLUME`, `CHANGE_EXERCISE`, or `PAIN_SWAP`; those belong to a
 * future Fatigue/Adaptation Engine, never this one (§16).
 */
export const PROGRESSION_DECISION_TYPES_V1 = [
  "NO_CHANGE",
  "MAINTAIN_LOAD_BUILD_REPS",
  "INCREASE_LOAD",
] as const;
export type ProgressionDecisionTypeV1 = (typeof PROGRESSION_DECISION_TYPES_V1)[number];

/**
 * §10.1's comparable-exposure tiers — only the two tiers an assembler is
 * ever expected to hand the pure engine. `NOT_COMPARABLE` exposures are
 * excluded before assembly (§29: "already tagged COMPARABLE/
 * COMPARABLE_WITH_CONTEXT") and are never a valid member of this engine's
 * input vocabulary; see `validate-input.ts` for the defense-in-depth
 * check that catches one anyway (a different `exerciseRef` slipping in).
 */
export const COMPARABILITY_TIERS_V1 = ["COMPARABLE", "COMPARABLE_WITH_CONTEXT"] as const;
export type ComparabilityTierV1 = (typeof COMPARABILITY_TIERS_V1)[number];

/**
 * §17.3 — a deterministic categorical confidence state, never a numeric
 * 0-100 score (the spec's explicit instruction: a number here would be
 * false precision the underlying evidence cannot support).
 */
export const EVIDENCE_STRENGTHS_V1 = ["INSUFFICIENT", "SINGLE_EXPOSURE", "SUPPORTED", "STRONG"] as const;
export type EvidenceStrengthV1 = (typeof EVIDENCE_STRENGTHS_V1)[number];

/**
 * §17.1's finite reason-code vocabulary, verbatim. `NO_SUITABLE_LOAD_INCREMENT`
 * is listed for completeness (it is part of `ProgressionDecisionDataV1`'s
 * persisted shape per §18) but is explicitly documented in the spec as
 * "applied by the application layer, not the engine" — `progressionPolicyV1`
 * in `./policy.ts` never emits it itself (see that module's own
 * `NEVER_EMITTED_BY_ENGINE` note and the invariant test enforcing this).
 */
export const REASON_CODES_V1 = [
  "TOP_OF_RANGE_ACHIEVED",
  "REPS_PROGRESSING",
  "PERFORMANCE_STABLE",
  "INSUFFICIENT_EVIDENCE",
  "SINGLE_EXPOSURE_ONLY",
  "PERFORMANCE_REGRESSED_SINGLE_EXPOSURE",
  "NON_COMPARABLE_CONTEXT",
  "PARTIAL_EXPOSURE",
  "PRESCRIPTION_CHANGED_RESET",
  "NO_SUITABLE_LOAD_INCREMENT",
] as const;
export type ReasonCodeV1 = (typeof REASON_CODES_V1)[number];

/**
 * §17.1's "pairs with" column, made checkable rather than only
 * documented in prose — a decision/reason combination outside this map
 * is a bug, not a valid engine output. `NO_SUITABLE_LOAD_INCREMENT` pairs
 * with `MAINTAIN_LOAD_BUILD_REPS` here because that is the *application
 * layer's* downgrade target (§17.1); `progressionPolicyV1` itself never
 * produces that pairing (see `policy.ts`).
 */
export const REASON_CODE_DECISION_PAIRS_V1: Readonly<Record<ReasonCodeV1, readonly ProgressionDecisionTypeV1[]>> = {
  TOP_OF_RANGE_ACHIEVED: ["INCREASE_LOAD"],
  REPS_PROGRESSING: ["MAINTAIN_LOAD_BUILD_REPS"],
  PERFORMANCE_STABLE: ["NO_CHANGE"],
  INSUFFICIENT_EVIDENCE: ["NO_CHANGE"],
  SINGLE_EXPOSURE_ONLY: ["NO_CHANGE"],
  PERFORMANCE_REGRESSED_SINGLE_EXPOSURE: ["NO_CHANGE"],
  NON_COMPARABLE_CONTEXT: ["NO_CHANGE"],
  PARTIAL_EXPOSURE: ["NO_CHANGE", "MAINTAIN_LOAD_BUILD_REPS"],
  PRESCRIPTION_CHANGED_RESET: ["NO_CHANGE"],
  NO_SUITABLE_LOAD_INCREMENT: ["MAINTAIN_LOAD_BUILD_REPS"],
};
