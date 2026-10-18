import type { ExternalWeightLoad, RepTargetV1 } from "@vostivo/domain";
import type { EvidenceStrengthV1, ProgressionDecisionTypeV1, ReasonCodeV1 } from "./vocabulary.js";

/**
 * §14's Load Resolver boundary (LOAD-INV-016): direction and current
 * state only, never a fabricated kg delta. Turning this into a new
 * prescribed load is a future application-layer composition step (Load
 * Resolver + this direction), never computed inside the pure engine.
 */
export interface IncreaseLoadDataV1 {
  readonly direction: "INCREASE";
  readonly currentLoad: ExternalWeightLoad;
  readonly currentTargetReps: RepTargetV1;
}

/**
 * §18's proposed shape — the `EngineDecision<"progression", ...>.data`
 * payload. This is the *entire* engine output; identity/audit fields
 * (`decisionId`, `athleteProfileId`, `createdAt`, ...) belong to the
 * future persistence layer (Slice C), never here — adding them to this
 * type would make the pure policy's output non-deterministic (§30 of the
 * task: no generated IDs/timestamps inside a pure engine result).
 */
export interface ProgressionDecisionDataV1 {
  readonly decisionType: ProgressionDecisionTypeV1;
  readonly reasonCode: ReasonCodeV1;
  readonly evidenceStrength: EvidenceStrengthV1;
  /** §17.2 — evidence metadata attached to `NO_CHANGE` only; never a decision type of its own, never acted on by this engine (§16). */
  readonly progressionStalled: boolean;
  readonly recommendedChange: IncreaseLoadDataV1 | null;
}
