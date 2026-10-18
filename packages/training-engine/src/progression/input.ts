import type { ExternalWeightLoad, RepTargetV1, SetType } from "@vostivo/domain";
import type { ComparabilityTierV1 } from "./vocabulary.js";
import type { RirV1 } from "./rir.js";

/**
 * One working set inside one exposure. `prescriptionSetId: null` means an
 * unplanned/extra set (§12.9) — real history, but it never counts toward
 * "every required working set reached the bar" and is excluded from the
 * evidence completeness calculation in `policy.ts`.
 *
 * `setType` is carried through (rather than assumed) so `validate-input.ts`
 * can reject a `WARM_UP` set that should never have reached this pure
 * engine at all (§5.6/§28's defense-in-depth requirement) — the assembler
 * is expected to have already filtered to `WORKING`, but this engine does
 * not trust that silently.
 */
export interface ProgressionExposureWorkingSetV1 {
  readonly prescriptionSetId: string | null;
  readonly setType: SetType;
  readonly actualReps: number;
  /** §15 — absent, never fabricated. */
  readonly performedRir?: RirV1;
}

/**
 * One exposure = the working sets an athlete performed for this exercise
 * in one session, already classified by the (future, Slice C) assembler
 * per §10.1. `exerciseRef` is repeated here (rather than assumed to match
 * the prescription) purely for `validate-input.ts`'s defense-in-depth
 * check (§28: "different exerciseRefs inside one evaluation" must be
 * rejected, not silently trusted).
 */
export interface ProgressionExposureV1 {
  readonly comparability: ComparabilityTierV1;
  readonly exerciseRef: string;
  readonly workingSets: readonly ProgressionExposureWorkingSetV1[];
}

/**
 * The current prescription's own target — every decision anchors to this,
 * never to a prior exposure's raw numbers directly (§12.4/§12.11).
 * `prescribedWorkingSetIds` is the canonical identity of the `WORKING`
 * slots that define "every required working set" for §12.1's top-of-range
 * gate; order within the array is not significant (matching is by
 * membership, never by position/timestamp — §22/§23).
 */
export interface ProgressionPrescriptionContextV1 {
  readonly exerciseRef: string;
  readonly prescriptionExerciseId: string;
  readonly targetReps: RepTargetV1;
  readonly targetLoad: ExternalWeightLoad;
  readonly prescribedWorkingSetIds: readonly string[];
  /** §15 — optional target RIR; only used to gate `STRONG` evidence (§17.3). */
  readonly targetRir?: RirV1;
}

/**
 * The fully normalized, pure engine input (§29). The engine never
 * queries anything itself — assembling this shape (Postgres access,
 * comparability classification, window bounding, `setType` filtering) is
 * an application-layer job (Slice C), not this package's concern.
 */
export interface ProgressionEvaluationInput {
  readonly prescription: ProgressionPrescriptionContextV1;
  /**
   * Ordered most-recent-first, length 0-3 (§11's bounded evidence
   * window). `exposures[0]`, when present, is the just-completed
   * exposure the decision is actually about — §11's "most recent
   * exposure, always inspected," and the one §12.1/§12.2's bar is
   * evaluated against (§11.1/OD-5: not gated by how many prior exposures
   * exist). `exposures[1]`/`[2]` are older comparable exposures used only
   * for trend/strength/stall classification. An empty array means
   * nothing has ever been performed for this exercise yet (PROG-029) —
   * distinct from a single exposure that already qualifies (PROG-028).
   */
  readonly exposures: readonly ProgressionExposureV1[];
  /**
   * Set by the (future) assembler when it excluded otherwise-existing
   * history because the current prescription's target changed since
   * those exposures were recorded (§12.11 — `PRESCRIPTION_CHANGED_RESET`).
   * The pure engine cannot detect a prescription change itself (it never
   * sees excluded/NOT_COMPARABLE history) — this flag only relabels *why*
   * evidence is currently limited; it never changes whether the current
   * exposure alone can still independently qualify for a decision
   * (§11.1's "not a waiting period" is unaffected by a reset window).
   */
  readonly priorExposuresExcludedByPrescriptionChange?: boolean;
}
