import { err, isSetType, ok, type Result } from "@vostivo/domain";
import { PRIORITY_TIERS_V1 } from "../available-time/vocabulary.js";
import type { EquipmentAdaptationInputV1 } from "./input.js";
import { PRESCRIPTION_COMPATIBILITIES_V1, SUBSTITUTE_COMPATIBILITY_TIERS_V1, SUBSTITUTION_POLICIES_V1 } from "./vocabulary.js";

export type EquipmentAdaptationInputValidationErrorV1 =
  | { readonly reason: "EMPTY_ID"; readonly field: string }
  | { readonly reason: "DUPLICATE_PLANNED_EXERCISE_ID"; readonly plannedExerciseId: string }
  | { readonly reason: "DUPLICATE_ORDER"; readonly plannedExerciseId: string }
  | { readonly reason: "INVALID_ORDER"; readonly plannedExerciseId: string }
  | { readonly reason: "UNSUPPORTED_SUBSTITUTION_POLICY"; readonly plannedExerciseId: string }
  | { readonly reason: "INVALID_SET"; readonly plannedExerciseId: string }
  | { readonly reason: "INVALID_AVAILABLE_TIME"; readonly plannedExerciseId: string }
  | { readonly reason: "UNSUPPORTED_COMPATIBILITY_TIER"; readonly plannedExerciseId: string }
  | { readonly reason: "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY"; readonly plannedExerciseId: string }
  | { readonly reason: "INVALID_SUBSTITUTION_PRIORITY"; readonly plannedExerciseId: string }
  | { readonly reason: "DUPLICATE_CANDIDATE"; readonly plannedExerciseId: string; readonly substituteExerciseId: string };

const isNonEmptyId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isIn = (values: readonly string[], value: unknown): boolean => typeof value === "string" && values.includes(value);

/**
 * Structural validation only. Structurally valid but semantically unsafe
 * input (no candidate, a lock, a tie) is never an error — it is a
 * REVIEW_REQUIRED decision.
 */
export function validateEquipmentAdaptationInput(input: EquipmentAdaptationInputV1): Result<EquipmentAdaptationInputV1, EquipmentAdaptationInputValidationErrorV1> {
  for (const [index, id] of input.availableEquipmentIds.entries()) if (!isNonEmptyId(id)) return err({ reason: "EMPTY_ID", field: `availableEquipmentIds[${index}]` });
  for (const [index, id] of input.athleteBlockedExerciseIds.entries()) if (!isNonEmptyId(id)) return err({ reason: "EMPTY_ID", field: `athleteBlockedExerciseIds[${index}]` });

  const plannedIds = new Set<string>();
  const orders = new Set<number>();
  for (const exercise of input.exercises) {
    const id = exercise.plannedExerciseId;
    if (!isNonEmptyId(id)) return err({ reason: "EMPTY_ID", field: "exercises[].plannedExerciseId" });
    if (plannedIds.has(id)) return err({ reason: "DUPLICATE_PLANNED_EXERCISE_ID", plannedExerciseId: id });
    plannedIds.add(id);
    if (!isNonEmptyId(exercise.exerciseId)) return err({ reason: "EMPTY_ID", field: `exercises[${id}].exerciseId` });
    if (!isNonNegativeInteger(exercise.order)) return err({ reason: "INVALID_ORDER", plannedExerciseId: id });
    if (orders.has(exercise.order)) return err({ reason: "DUPLICATE_ORDER", plannedExerciseId: id });
    orders.add(exercise.order);
    if (!isIn(SUBSTITUTION_POLICIES_V1, exercise.substitutionPolicy)) return err({ reason: "UNSUPPORTED_SUBSTITUTION_POLICY", plannedExerciseId: id });
    for (const [index, equipmentId] of exercise.requiredEquipmentIds.entries()) {
      if (!isNonEmptyId(equipmentId)) return err({ reason: "EMPTY_ID", field: `exercises[${id}].requiredEquipmentIds[${index}]` });
    }
    const setIds = new Set<string>();
    for (const set of exercise.sets) {
      if (!isNonEmptyId(set.plannedSetId) || setIds.has(set.plannedSetId) || !isNonNegativeInteger(set.order) || !isSetType(set.setType)) return err({ reason: "INVALID_SET", plannedExerciseId: id });
      if (set.restSeconds !== null && !isNonNegativeInteger(set.restSeconds)) return err({ reason: "INVALID_SET", plannedExerciseId: id });
      setIds.add(set.plannedSetId);
    }
    if (exercise.availableTime !== null) {
      const workingSets = exercise.sets.filter((s) => s.setType === "WORKING").length;
      if (!isIn(PRIORITY_TIERS_V1, exercise.availableTime.priorityTier) || !isNonNegativeInteger(exercise.availableTime.minimumWorkingSets) || exercise.availableTime.minimumWorkingSets > workingSets) {
        return err({ reason: "INVALID_AVAILABLE_TIME", plannedExerciseId: id });
      }
    }
    const candidateIds = new Set<string>();
    for (const candidate of exercise.candidates) {
      if (!isNonEmptyId(candidate.substituteExerciseId)) return err({ reason: "EMPTY_ID", field: `exercises[${id}].candidates[].substituteExerciseId` });
      if (candidateIds.has(candidate.substituteExerciseId)) return err({ reason: "DUPLICATE_CANDIDATE", plannedExerciseId: id, substituteExerciseId: candidate.substituteExerciseId });
      candidateIds.add(candidate.substituteExerciseId);
      if (!isIn(SUBSTITUTE_COMPATIBILITY_TIERS_V1, candidate.compatibilityTier)) return err({ reason: "UNSUPPORTED_COMPATIBILITY_TIER", plannedExerciseId: id });
      if (!isIn(PRESCRIPTION_COMPATIBILITIES_V1, candidate.prescriptionCompatibility)) return err({ reason: "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY", plannedExerciseId: id });
      if (!isPositiveInteger(candidate.substitutionPriority)) return err({ reason: "INVALID_SUBSTITUTION_PRIORITY", plannedExerciseId: id });
      for (const [index, equipmentId] of candidate.requiredEquipmentIds.entries()) {
        if (!isNonEmptyId(equipmentId)) return err({ reason: "EMPTY_ID", field: `exercises[${id}].candidates[${candidate.substituteExerciseId}].requiredEquipmentIds[${index}]` });
      }
    }
  }
  return ok(input);
}
