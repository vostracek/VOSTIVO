import type { EngineVersion } from "./engine-version.js";

/**
 * Vocabulary for an explainable engine decision. Concrete decision kinds
 * (progression, deload, substitution, ...) are added per vertical slice —
 * this bootstrap only fixes the shared envelope shape.
 */
export interface EngineDecision<Kind extends string = string, Data = unknown> {
  readonly kind: Kind;
  readonly version: EngineVersion;
  readonly data: Data;
  /** Human-readable justification, required so decisions stay explainable. */
  readonly reason: string;
}

export interface EnginePolicy<Input, Kind extends string, Data> {
  readonly version: EngineVersion;
  decide(input: Input): EngineDecision<Kind, Data>;
}
