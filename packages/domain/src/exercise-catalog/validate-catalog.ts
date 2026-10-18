import { err, ok, type Result } from "../result.js";
import type { ExerciseEquipmentCatalogV1 } from "./types.js";
import { PRESCRIPTION_COMPATIBILITIES_V1, SUBSTITUTE_COMPATIBILITY_TIERS_V1 } from "./vocabulary.js";

export type CatalogIssueV1 =
  | { readonly reason: "EMPTY_VERSION" }
  | { readonly reason: "EMPTY_ID"; readonly field: string }
  | { readonly reason: "EMPTY_LABEL"; readonly id: string }
  | { readonly reason: "DUPLICATE_EQUIPMENT_ID"; readonly equipmentId: string }
  | { readonly reason: "DUPLICATE_EXERCISE_REF"; readonly exerciseRef: string }
  | { readonly reason: "DUPLICATE_REQUIRED_EQUIPMENT"; readonly exerciseRef: string; readonly equipmentId: string }
  | { readonly reason: "UNKNOWN_REQUIRED_EQUIPMENT"; readonly exerciseRef: string; readonly equipmentId: string }
  | { readonly reason: "UNKNOWN_SUBSTITUTION_SOURCE"; readonly exerciseRef: string }
  | { readonly reason: "UNKNOWN_SUBSTITUTION_TARGET"; readonly exerciseRef: string }
  | { readonly reason: "SELF_SUBSTITUTION"; readonly exerciseRef: string }
  | { readonly reason: "INVALID_PRIORITY"; readonly source: string; readonly substitute: string }
  | { readonly reason: "INVALID_COMPATIBILITY_TIER"; readonly source: string; readonly substitute: string }
  | { readonly reason: "INVALID_PRESCRIPTION_COMPATIBILITY"; readonly source: string; readonly substitute: string }
  | { readonly reason: "DUPLICATE_EDGE"; readonly source: string; readonly substitute: string }
  | { readonly reason: "AMBIGUOUS_EQUIVALENT_PRIORITY"; readonly source: string; readonly substitutionPriority: number };

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Pure STRUCTURAL validation of a reference catalog (the canonical one is
 * proven valid by tests). Collects every issue (deterministic order), so a
 * bad catalog edit is fully explained at once.
 */
export function validateExerciseEquipmentCatalog(catalog: ExerciseEquipmentCatalogV1): Result<ExerciseEquipmentCatalogV1, readonly CatalogIssueV1[]> {
  const issues: CatalogIssueV1[] = [];
  if (!nonEmpty(catalog.version)) issues.push({ reason: "EMPTY_VERSION" });

  const equipmentIds = new Set<string>();
  for (const equipment of catalog.equipment) {
    if (!nonEmpty(equipment.equipmentId)) issues.push({ reason: "EMPTY_ID", field: "equipment[].equipmentId" });
    else if (equipmentIds.has(equipment.equipmentId)) issues.push({ reason: "DUPLICATE_EQUIPMENT_ID", equipmentId: equipment.equipmentId });
    if (!nonEmpty(equipment.displayLabel)) issues.push({ reason: "EMPTY_LABEL", id: equipment.equipmentId });
    equipmentIds.add(equipment.equipmentId);
  }

  const exerciseRefs = new Set<string>();
  for (const exercise of catalog.exercises) {
    if (!nonEmpty(exercise.exerciseRef)) issues.push({ reason: "EMPTY_ID", field: "exercises[].exerciseRef" });
    else if (exerciseRefs.has(exercise.exerciseRef)) issues.push({ reason: "DUPLICATE_EXERCISE_REF", exerciseRef: exercise.exerciseRef });
    if (!nonEmpty(exercise.displayName)) issues.push({ reason: "EMPTY_LABEL", id: exercise.exerciseRef });
    exerciseRefs.add(exercise.exerciseRef);
    const seen = new Set<string>();
    for (const equipmentId of exercise.requiredEquipmentIds) {
      if (seen.has(equipmentId)) issues.push({ reason: "DUPLICATE_REQUIRED_EQUIPMENT", exerciseRef: exercise.exerciseRef, equipmentId });
      seen.add(equipmentId);
      if (!equipmentIds.has(equipmentId)) issues.push({ reason: "UNKNOWN_REQUIRED_EQUIPMENT", exerciseRef: exercise.exerciseRef, equipmentId });
    }
  }

  const edges = new Set<string>();
  const equivalentPriorities = new Map<string, Set<number>>();
  for (const edge of catalog.substitutions) {
    const source = edge.sourceExerciseRef;
    const substitute = edge.substituteExerciseRef;
    if (!exerciseRefs.has(source)) issues.push({ reason: "UNKNOWN_SUBSTITUTION_SOURCE", exerciseRef: source });
    if (!exerciseRefs.has(substitute)) issues.push({ reason: "UNKNOWN_SUBSTITUTION_TARGET", exerciseRef: substitute });
    if (source === substitute) issues.push({ reason: "SELF_SUBSTITUTION", exerciseRef: source });
    if (!(typeof edge.substitutionPriority === "number" && Number.isInteger(edge.substitutionPriority) && edge.substitutionPriority > 0)) {
      issues.push({ reason: "INVALID_PRIORITY", source, substitute });
    }
    if (!(SUBSTITUTE_COMPATIBILITY_TIERS_V1 as readonly string[]).includes(edge.compatibilityTier)) issues.push({ reason: "INVALID_COMPATIBILITY_TIER", source, substitute });
    if (!(PRESCRIPTION_COMPATIBILITIES_V1 as readonly string[]).includes(edge.prescriptionCompatibility)) issues.push({ reason: "INVALID_PRESCRIPTION_COMPATIBILITY", source, substitute });
    const key = `${source}\u0000${substitute}`;
    if (edges.has(key)) issues.push({ reason: "DUPLICATE_EDGE", source, substitute });
    edges.add(key);
    // Curated catalog: automatic (equivalent + preserving) candidates must never tie on priority for one source.
    if (edge.compatibilityTier === "ROLE_EQUIVALENT" && edge.prescriptionCompatibility === "PRESERVE_WORKING_PRESCRIPTION") {
      const priorities = equivalentPriorities.get(source) ?? new Set<number>();
      if (priorities.has(edge.substitutionPriority)) issues.push({ reason: "AMBIGUOUS_EQUIVALENT_PRIORITY", source, substitutionPriority: edge.substitutionPriority });
      priorities.add(edge.substitutionPriority);
      equivalentPriorities.set(source, priorities);
    }
  }

  return issues.length === 0 ? ok(catalog) : err(issues);
}
