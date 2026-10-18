import type { EngineDecision, EnginePolicy } from "../decision.js";
import { err, ok, type Result } from "@vostivo/domain";
import type { ProgressionEvaluationInput, ProgressionExposureV1, ProgressionExposureWorkingSetV1 } from "./input.js";
import type { ProgressionDecisionDataV1 } from "./decision-data.js";
import type { EvidenceStrengthV1, ProgressionDecisionTypeV1, ReasonCodeV1 } from "./vocabulary.js";
import { validateProgressionInput, type ProgressionInputValidationErrorV1 } from "./validate-input.js";

/**
 * Pure Progression Engine V1 (docs/domain/PROGRESSION-ENGINE-V1.md §12,
 * §29). The whole module is deterministic and side-effect free: no DB, no
 * network, no clock, no randomness — the same input always produces the
 * same `ProgressionDecisionDataV1` (§19, proven by
 * `policy.test.ts`'s determinism tests).
 */

const REASON_CODE_DESCRIPTIONS_V1: Readonly<Record<ReasonCodeV1, string>> = {
  TOP_OF_RANGE_ACHIEVED: "Every required working set met or exceeded the top of the target this exposure.",
  REPS_PROGRESSING: "Reps are trending upward but not every working set has reached the target bar yet.",
  PERFORMANCE_STABLE: "Comparable evidence exists but shows no improving or regressing trend.",
  INSUFFICIENT_EVIDENCE: "No usable working-set evidence exists for this exercise yet.",
  SINGLE_EXPOSURE_ONLY: "Exactly one comparable exposure exists — not enough to establish a trend.",
  PERFORMANCE_REGRESSED_SINGLE_EXPOSURE: "The most recent exposure alone fell below the target.",
  NON_COMPARABLE_CONTEXT: "Nothing in the supplied evidence is classified as comparable.",
  PARTIAL_EXPOSURE: "Fewer working sets were completed than the current prescription requires.",
  PRESCRIPTION_CHANGED_RESET: "The prescription changed since prior evidence, so the evidence window was reset.",
  NO_SUITABLE_LOAD_INCREMENT: "The application layer found no achievable load increment for this recommendation.",
};

interface ExposureClassification {
  readonly completeness: "EMPTY" | "PARTIAL" | "FULL";
  readonly allAtBar: boolean;
  readonly anyAtBar: boolean;
  readonly anyBelowFloor: boolean;
  readonly trend: "IMPROVING" | "FLAT" | "REGRESSED" | "UNKNOWN";
}

function mappedWorkingSets(
  exposure: ProgressionExposureV1,
  prescribedWorkingSetIds: readonly string[],
): readonly ProgressionExposureWorkingSetV1[] {
  return exposure.workingSets.filter(
    (set) => set.prescriptionSetId !== null && prescribedWorkingSetIds.includes(set.prescriptionSetId),
  );
}

/**
 * §12.3/§8 (task)'s "one clear deterministic comparator": no set may
 * decrease relative to its own canonical `prescriptionSetId` slot in the
 * immediately older exposure, and at least one slot must genuinely
 * improve, for the pair to count as an improving trend. Matching by
 * `prescriptionSetId` (never index/timestamp — §22/§23) means a slot only
 * counts when it exists in both exposures; sets with no counterpart are
 * ignored rather than guessed at. Deliberately NOT independent-per-set
 * (a tied slot does not block "improving"), and deliberately NOT a
 * weighted/summed score — see `policy.test.ts`'s "improvement comparator"
 * suite for the exact worked cases this resolves without needing a STOP.
 */
function trendVsPrevious(
  currentMapped: readonly ProgressionExposureWorkingSetV1[],
  previousMapped: readonly ProgressionExposureWorkingSetV1[],
): ExposureClassification["trend"] {
  const previousBySlot = new Map(
    previousMapped
      .filter((set) => set.prescriptionSetId !== null)
      .map((set) => [set.prescriptionSetId as string, set.actualReps]),
  );

  let sawIncrease = false;
  let sawDecrease = false;
  let overlapCount = 0;
  for (const set of currentMapped) {
    if (set.prescriptionSetId === null) continue;
    const previousReps = previousBySlot.get(set.prescriptionSetId);
    if (previousReps === undefined) continue;
    overlapCount += 1;
    if (set.actualReps > previousReps) sawIncrease = true;
    else if (set.actualReps < previousReps) sawDecrease = true;
  }

  if (overlapCount === 0) return "UNKNOWN";
  if (sawDecrease) return "REGRESSED";
  if (sawIncrease) return "IMPROVING";
  return "FLAT";
}

function classifyExposure(
  exposure: ProgressionExposureV1,
  previousExposure: ProgressionExposureV1 | undefined,
  prescription: ProgressionEvaluationInput["prescription"],
): ExposureClassification {
  const target = prescription.targetReps;
  const bar = target.kind === "EXACT" ? target.reps : target.maxReps;
  const floor = target.kind === "EXACT" ? target.reps : target.minReps;

  const mapped = mappedWorkingSets(exposure, prescription.prescribedWorkingSetIds);
  const isFull = prescription.prescribedWorkingSetIds.every((id) =>
    mapped.some((set) => set.prescriptionSetId === id),
  );
  const completeness: ExposureClassification["completeness"] =
    mapped.length === 0 ? "EMPTY" : isFull ? "FULL" : "PARTIAL";

  const allAtBar = completeness === "FULL" && mapped.every((set) => set.actualReps >= bar);
  const anyAtBar = mapped.some((set) => set.actualReps >= bar);
  const anyBelowFloor = mapped.some((set) => set.actualReps < floor);

  const previousMapped =
    previousExposure === undefined ? [] : mappedWorkingSets(previousExposure, prescription.prescribedWorkingSetIds);
  const trend = previousExposure === undefined ? "UNKNOWN" : trendVsPrevious(mapped, previousMapped);

  return { completeness, allAtBar, anyAtBar, anyBelowFloor, trend };
}

type ExposureDirection = "PROGRESS" | "REGRESS" | "STABLE";

function directionOf(classification: ExposureClassification): ExposureDirection {
  if (classification.allAtBar || classification.anyAtBar || classification.trend === "IMPROVING") return "PROGRESS";
  if (classification.anyBelowFloor || classification.trend === "REGRESSED") return "REGRESS";
  return "STABLE";
}

/**
 * §17.3's deterministic categorical state — never a numeric score.
 * Computed purely from the shape of the supplied window (count, tier,
 * RIR presence), independent of which decision that evidence produces.
 */
function evidenceStrength(
  exposures: readonly ProgressionExposureV1[],
  prescription: ProgressionEvaluationInput["prescription"],
): EvidenceStrengthV1 {
  if (exposures.length === 0) return "INSUFFICIENT";
  if (exposures.length === 1) return "SINGLE_EXPOSURE";

  const anyWithContext = exposures.some((exposure) => exposure.comparability === "COMPARABLE_WITH_CONTEXT");
  if (exposures.length < 3 || anyWithContext) return "SUPPORTED";

  const classifications = exposures.map((exposure, index) => classifyExposure(exposure, exposures[index + 1], prescription));
  const directions = classifications.map(directionOf);
  const allAgree = directions.every((direction) => direction === directions[0]);

  const evidenceSets = exposures.flatMap((exposure) => mappedWorkingSets(exposure, prescription.prescribedWorkingSetIds));
  const rirMissingAnywhere = evidenceSets.some((set) => set.performedRir === undefined);
  const targetRir = prescription.targetRir;
  const rirCorroborates =
    !rirMissingAnywhere && (targetRir === undefined || evidenceSets.every((set) => (set.performedRir?.value ?? Number.POSITIVE_INFINITY) <= targetRir.value));

  return allAgree && rirCorroborates ? "STRONG" : "SUPPORTED";
}

/**
 * §17.2/OD-6 — evidence metadata attached to `NO_CHANGE` only, never a
 * decision of its own and never acted on by this engine (§16). Requires
 * the *full* 3-exposure window (a repeated-pattern signal cannot honestly
 * be claimed from fewer data points) showing neither a top-of-range
 * result nor any improvement anywhere in the window.
 */
function computeProgressionStalled(
  decisionType: ProgressionDecisionTypeV1,
  exposures: readonly ProgressionExposureV1[],
  prescription: ProgressionEvaluationInput["prescription"],
): boolean {
  if (decisionType !== "NO_CHANGE" || exposures.length !== 3) return false;
  return exposures.every((exposure, index) => {
    const classification = classifyExposure(exposure, exposures[index + 1], prescription);
    return !classification.allAtBar && !classification.anyAtBar && classification.trend !== "IMPROVING";
  });
}

function decideCore(input: ProgressionEvaluationInput): ProgressionDecisionDataV1 {
  const { prescription, exposures, priorExposuresExcludedByPrescriptionChange } = input;
  const current = exposures[0];

  let decisionType: ProgressionDecisionTypeV1;
  let reasonCode: ReasonCodeV1;

  if (current === undefined) {
    decisionType = "NO_CHANGE";
    reasonCode = priorExposuresExcludedByPrescriptionChange === true ? "PRESCRIPTION_CHANGED_RESET" : "INSUFFICIENT_EVIDENCE";
  } else {
    const classification = classifyExposure(current, exposures[1], prescription);
    const isExact = prescription.targetReps.kind === "EXACT";

    if (classification.completeness === "EMPTY") {
      decisionType = "NO_CHANGE";
      reasonCode = priorExposuresExcludedByPrescriptionChange === true ? "PRESCRIPTION_CHANGED_RESET" : "INSUFFICIENT_EVIDENCE";
    } else if (classification.allAtBar) {
      // §12.1/§12.2, §11.1/OD-5: a single qualifying exposure is enough —
      // never gated by how many prior exposures exist.
      decisionType = "INCREASE_LOAD";
      reasonCode = "TOP_OF_RANGE_ACHIEVED";
    } else if (isExact) {
      // §10/§12.2: EXACT never returns MAINTAIN_LOAD_BUILD_REPS.
      if (classification.completeness === "PARTIAL") {
        decisionType = "NO_CHANGE";
        reasonCode = "PARTIAL_EXPOSURE";
      } else if (classification.anyBelowFloor || classification.trend === "REGRESSED") {
        decisionType = "NO_CHANGE";
        reasonCode = "PERFORMANCE_REGRESSED_SINGLE_EXPOSURE";
      } else if (exposures.length === 1) {
        decisionType = "NO_CHANGE";
        reasonCode = "SINGLE_EXPOSURE_ONLY";
      } else {
        decisionType = "NO_CHANGE";
        reasonCode = "PERFORMANCE_STABLE";
      }
    } else if (classification.completeness === "PARTIAL") {
      // §12.8/§17.1: partial evidence is never treated as failure; the
      // completed subset may still show §12.3's pattern.
      decisionType = classification.anyAtBar ? "MAINTAIN_LOAD_BUILD_REPS" : "NO_CHANGE";
      reasonCode = "PARTIAL_EXPOSURE";
    } else if (classification.anyBelowFloor || classification.trend === "REGRESSED") {
      // RANGE precedence fix (Progression RANGE Precedence Fix, 2026-09-22):
      // regression/below-floor evidence is checked BEFORE the "any set
      // touched the bar" positive-progress check below. A single required
      // set reaching maxReps must never mask a genuine regression in the
      // other required sets (e.g. prior 11/10/9 -> current 12/9/8: slot 1
      // improved, but slots 2 and 3 both regressed — the exposure as a
      // whole is regressed, and must never read as MAINTAIN_LOAD_BUILD_REPS
      // merely because slot 1 incidentally touched the top of the range).
      // This does not affect the full-top-of-range bar above (§12.1) — that
      // check already ran first and only fires when every required set is
      // at or above the bar, i.e. there is no regressed slot to contradict.
      decisionType = "NO_CHANGE";
      reasonCode = "PERFORMANCE_REGRESSED_SINGLE_EXPOSURE";
    } else if (classification.anyAtBar || classification.trend === "IMPROVING") {
      // §12.3/§12.5: at least one required set touched the top this
      // exposure, or a genuine per-slot improvement over the immediately
      // prior comparable exposure — real forward progress, not yet every
      // set at the bar, and (per the precedence fix above) never
      // contradicted by a regressed slot elsewhere in the same exposure.
      decisionType = "MAINTAIN_LOAD_BUILD_REPS";
      reasonCode = "REPS_PROGRESSING";
    } else if (exposures.length === 1) {
      decisionType = "NO_CHANGE";
      reasonCode = "SINGLE_EXPOSURE_ONLY";
    } else {
      decisionType = "NO_CHANGE";
      reasonCode = "PERFORMANCE_STABLE";
    }
  }

  const progressionStalled = computeProgressionStalled(decisionType, exposures, prescription);
  const strength = evidenceStrength(exposures, prescription);

  return {
    decisionType,
    reasonCode,
    evidenceStrength: strength,
    progressionStalled,
    recommendedChange:
      decisionType === "INCREASE_LOAD"
        ? { direction: "INCREASE", currentLoad: prescription.targetLoad, currentTargetReps: prescription.targetReps }
        : null,
  };
}

/**
 * The reused `EnginePolicy` contract exactly (§29's proposed shape) —
 * not a new abstraction. `decide()` assumes structurally valid input
 * (matching the spec's own literal code sample); callers that cannot
 * guarantee that should call `evaluateProgression()` instead, which
 * validates first and never reaches this function with malformed input.
 *
 * If `decide()` is nonetheless ever called directly with invalid input,
 * it degrades to `NO_CHANGE`/`INSUFFICIENT_EVIDENCE` rather than throwing
 * or producing a misleading recommendation — one of the two behaviors the
 * spec's "Failure mode" section explicitly allows (the other being a
 * thrown error the application layer catches; this policy never throws).
 */
export const progressionPolicyV1: EnginePolicy<ProgressionEvaluationInput, "progression", ProgressionDecisionDataV1> = {
  version: { engine: "progression", policy: "v1" },
  decide(input) {
    const validation = validateProgressionInput(input);
    const data: ProgressionDecisionDataV1 = validation.ok
      ? decideCore(input)
      : {
          decisionType: "NO_CHANGE",
          reasonCode: "INSUFFICIENT_EVIDENCE",
          evidenceStrength: "INSUFFICIENT",
          progressionStalled: false,
          recommendedChange: null,
        };
    return {
      kind: "progression",
      version: progressionPolicyV1.version,
      data,
      reason: REASON_CODE_DESCRIPTIONS_V1[data.reasonCode],
    };
  },
};

/**
 * The recommended public entry point (§29's "expected conceptual
 * evaluation"). Validates the input explicitly (§28) and only ever calls
 * into `progressionPolicyV1.decide()` once that succeeds, so a caller
 * gets a clear, typed distinction between "structurally invalid input"
 * (`err`) and "a real decision, however low-confidence" (`ok`).
 */
export function evaluateProgression(
  input: ProgressionEvaluationInput,
): Result<EngineDecision<"progression", ProgressionDecisionDataV1>, ProgressionInputValidationErrorV1> {
  const validation = validateProgressionInput(input);
  if (!validation.ok) return err(validation.error);
  return ok(progressionPolicyV1.decide(validation.value));
}
