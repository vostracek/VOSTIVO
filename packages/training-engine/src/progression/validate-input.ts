import { err, ok, type Result } from "@vostivo/domain";
import type { ProgressionEvaluationInput, ProgressionExposureV1 } from "./input.js";

/**
 * §28's "invalid input" list, made explicit and checkable. This
 * differentiates *valid but insufficient* evidence (which is a normal
 * `NO_CHANGE`/`INSUFFICIENT_EVIDENCE` decision — see `policy.ts`) from a
 * *structurally broken* normalized input (an assembler bug), using this
 * package's existing `Result` convention (`@vostivo/domain`) rather than
 * throwing an uncontrolled error.
 */
export type ProgressionInputValidationErrorV1 =
  | { readonly reason: "NO_PRESCRIBED_WORKING_SETS" }
  | { readonly reason: "INVALID_REP_TARGET" }
  | { readonly reason: "INVALID_EXTERNAL_LOAD" }
  | { readonly reason: "EVIDENCE_WINDOW_EXCEEDED" }
  | { readonly reason: "DUPLICATE_PRESCRIPTION_SET_ID"; readonly exposureIndex: number }
  | { readonly reason: "EXERCISE_REF_MISMATCH"; readonly exposureIndex: number }
  | { readonly reason: "UNEXPECTED_WARM_UP_EVIDENCE"; readonly exposureIndex: number }
  | { readonly reason: "INVALID_WORKING_SET_DATA"; readonly exposureIndex: number };

const MAX_EVIDENCE_WINDOW = 3;

function validateExposure(
  exposure: ProgressionExposureV1,
  exposureIndex: number,
  exerciseRef: string,
): ProgressionInputValidationErrorV1 | null {
  if (exposure.exerciseRef !== exerciseRef) {
    return { reason: "EXERCISE_REF_MISMATCH", exposureIndex };
  }

  const seenPrescriptionSetIds = new Set<string>();
  for (const set of exposure.workingSets) {
    // Defense-in-depth (§5/§28): the assembler is expected to have
    // already filtered to WORKING, but this engine never trusts that
    // silently — a WARM_UP set reaching here is an assembly bug, not
    // evidence to quietly drop.
    if (set.setType !== "WORKING") {
      return { reason: "UNEXPECTED_WARM_UP_EVIDENCE", exposureIndex };
    }
    if (!Number.isInteger(set.actualReps) || set.actualReps < 0) {
      return { reason: "INVALID_WORKING_SET_DATA", exposureIndex };
    }
    if (set.prescriptionSetId !== null) {
      if (seenPrescriptionSetIds.has(set.prescriptionSetId)) {
        return { reason: "DUPLICATE_PRESCRIPTION_SET_ID", exposureIndex };
      }
      seenPrescriptionSetIds.add(set.prescriptionSetId);
    }
  }

  return null;
}

function isValidExternalWeightLoad(load: ProgressionEvaluationInput["prescription"]["targetLoad"]): boolean {
  return (
    load.kind === "EXTERNAL_WEIGHT" &&
    Number.isInteger(load.amountMilli) &&
    load.amountMilli > 0 &&
    (load.unit === "KG" || load.unit === "LB") &&
    (load.basis === "TOTAL" || load.basis === "PER_IMPLEMENT")
  );
}

/**
 * Validates a `ProgressionEvaluationInput` structurally — never whether
 * the evidence is *sufficient* (that is `policy.ts`'s job and a normal
 * decision outcome, not a validation failure).
 */
export function validateProgressionInput(
  input: ProgressionEvaluationInput,
): Result<ProgressionEvaluationInput, ProgressionInputValidationErrorV1> {
  const { prescription, exposures } = input;

  if (prescription.prescribedWorkingSetIds.length === 0) {
    return err({ reason: "NO_PRESCRIBED_WORKING_SETS" });
  }

  const target = prescription.targetReps;
  const isValidRepTarget =
    target.kind === "EXACT"
      ? Number.isInteger(target.reps) && target.reps > 0
      : Number.isInteger(target.minReps) &&
        Number.isInteger(target.maxReps) &&
        target.minReps > 0 &&
        target.maxReps >= target.minReps;
  if (!isValidRepTarget) {
    return err({ reason: "INVALID_REP_TARGET" });
  }

  if (!isValidExternalWeightLoad(prescription.targetLoad)) {
    return err({ reason: "INVALID_EXTERNAL_LOAD" });
  }

  if (exposures.length > MAX_EVIDENCE_WINDOW) {
    return err({ reason: "EVIDENCE_WINDOW_EXCEEDED" });
  }

  for (const [exposureIndex, exposure] of exposures.entries()) {
    const exposureError = validateExposure(exposure, exposureIndex, prescription.exerciseRef);
    if (exposureError !== null) return err(exposureError);
  }

  return ok(input);
}
