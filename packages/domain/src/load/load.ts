/**
 * Load Model V1 — Stage 1 subset only (docs/domain/load-model-v1.md
 * section 106). This vertical slice implements EXTERNAL_WEIGHT /
 * KG|LB / TOTAL|PER_IMPLEMENT — the common case of a barbell/dumbbell
 * external load. Every other LoadKind (BODYWEIGHT, ASSISTANCE_WEIGHT,
 * MACHINE_LEVEL, NON_WEIGHT_RESISTANCE, NONE, ADDED_BODYWEIGHT_WEIGHT) and
 * every other basis (PER_SIDE, DISPLAYED_STACK, LEVEL, ...) is a later
 * stage — do not add them speculatively here (spec section 106-108).
 */
export const LOAD_KINDS_V1 = ["EXTERNAL_WEIGHT"] as const;
export type LoadKindV1 = (typeof LOAD_KINDS_V1)[number];

export const LOAD_UNITS = ["KG", "LB"] as const;
export type LoadUnit = (typeof LOAD_UNITS)[number];

export const LOAD_BASES_V1 = ["TOTAL", "PER_IMPLEMENT"] as const;
export type LoadBasisV1 = (typeof LOAD_BASES_V1)[number];

/**
 * `amountMilli` is a fixed-precision integer, scale 1000 (LOAD-INV-002) —
 * 40 kg is `amountMilli: 40000`, never a floating-point `40`. Dumbbells
 * "40 kg each" is `{ amountMilli: 40000, unit: "KG", basis:
 * "PER_IMPLEMENT" }`, never summed to 80000 TOTAL (LOAD-INV-005).
 *
 * This shape is used for both a prescribed target load and a performed
 * actual load — Stage 1 does not need them to differ structurally, only
 * semantically (one is historical context, the other is reality; spec
 * section 66-67).
 */
export interface ExternalWeightLoad {
  readonly kind: "EXTERNAL_WEIGHT";
  readonly amountMilli: number;
  readonly unit: LoadUnit;
  readonly basis: LoadBasisV1;
}

/**
 * Only variant implemented in Stage 1. Extend this to a real union
 * (`ExternalWeightLoad | BodyweightLoad | ...`) when a later stage adds
 * another LoadKind — do not pre-declare the union now.
 */
export type PerformedLoadV1 = ExternalWeightLoad;
