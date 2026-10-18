/**
 * §15's RIR/effort contract — representation only, no persistence/UI
 * (OD-2: RIR is optional, never a blocker, never fabricated when absent).
 * `3` is a categorical ceiling ("3 or more"), never normalized to a
 * fabricated continuous value like `3.5` — athletes cannot reliably
 * self-report finer than this bucket.
 */
export const RIR_VALUES_V1 = [0, 1, 2, 3] as const;
export type RirValueV1 = (typeof RIR_VALUES_V1)[number];

export interface RirV1 {
  readonly kind: "RIR";
  readonly value: RirValueV1;
}
