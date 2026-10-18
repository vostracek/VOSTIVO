import type { EquipmentAdaptationOptionV1 } from "@vostivo/contracts";
import { EXERCISE_EQUIPMENT_CATALOG_V1, exerciseEquipmentCatalogV1, type ExerciseEquipmentCatalogLookupV1 } from "@vostivo/domain";

/**
 * Temporary Equipment V1 — Slice D: the decision-relevant equipment of one
 * workout, PURE over the canonical catalog. Relevant = required by a
 * planned exercise, or by one of its explicit curated substitutes (one hop,
 * every curated edge). A null or unknown exercise identity contributes
 * nothing (it is never auto-adapted, so no equipment choice can change it).
 * Order: PLANNED first, then SUBSTITUTE, each in catalog declaration order.
 */
export function computeEquipmentAdaptationOptions(
  exerciseRefs: readonly (string | null)[],
  catalog: ExerciseEquipmentCatalogLookupV1 = exerciseEquipmentCatalogV1,
  equipmentOrder: readonly string[] = EXERCISE_EQUIPMENT_CATALOG_V1.equipment.map((e) => e.equipmentId),
): EquipmentAdaptationOptionV1[] {
  const planned = new Set<string>();
  const substitute = new Set<string>();
  for (const exerciseRef of exerciseRefs) {
    if (exerciseRef === null) continue;
    const definition = catalog.getExerciseDefinition(exerciseRef);
    if (definition === null) continue;
    for (const id of definition.requiredEquipmentIds) planned.add(id);
    for (const edge of catalog.getSubstitutionEdges(exerciseRef)) {
      for (const id of catalog.getExerciseDefinition(edge.substituteExerciseRef)?.requiredEquipmentIds ?? []) substitute.add(id);
    }
  }
  const options: EquipmentAdaptationOptionV1[] = [];
  for (const relevance of ["PLANNED", "SUBSTITUTE"] as const) {
    for (const equipmentId of equipmentOrder) {
      const included = relevance === "PLANNED" ? planned.has(equipmentId) : substitute.has(equipmentId) && !planned.has(equipmentId);
      const definition = included ? catalog.getEquipmentDefinition(equipmentId) : null;
      if (definition !== null) options.push({ equipmentId, displayLabel: definition.displayLabel, relevance });
    }
  }
  return options;
}
