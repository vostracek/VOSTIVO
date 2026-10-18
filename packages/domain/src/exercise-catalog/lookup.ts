import type { ExerciseIdentityV1 } from "../exercise-identity.js";
import { EXERCISE_EQUIPMENT_CATALOG_V1 } from "./catalog-data.js";
import { deepFreeze } from "./deep-freeze.js";
import type { EquipmentDefinitionV1, EquipmentIdV1, ExerciseDefinitionV1, ExerciseEquipmentCatalogV1, SubstitutionEdgeV1 } from "./types.js";

/**
 * NULL/UNKNOWN EXERCISES ARE NOT AUTO-ADAPTED: an exercise without a ref,
 * or with a ref the catalog does not know, is reported as unsupported —
 * never matched by display name, never assumed available.
 */
export type ExerciseIdentityResolutionV1 =
  | { readonly kind: "CATALOG_EXERCISE"; readonly definition: ExerciseDefinitionV1 }
  | { readonly kind: "UNSUPPORTED_EXERCISE_IDENTITY"; readonly reason: "NULL_EXERCISE_REF" | "UNKNOWN_EXERCISE_REF" };

export interface ExerciseEquipmentCatalogLookupV1 {
  readonly version: string;
  /** `null` = not in the catalog (exact ref match only — never by name). */
  getExerciseDefinition(exerciseRef: ExerciseIdentityV1): ExerciseDefinitionV1 | null;
  /** `null` = not a canonical equipment id. */
  getEquipmentDefinition(equipmentId: EquipmentIdV1): EquipmentDefinitionV1 | null;
  /** The source's explicit outgoing edges, ordered by (priority, substitute ref) — never declaration order. `[]` = none curated. */
  getSubstitutionEdges(sourceExerciseRef: ExerciseIdentityV1): readonly SubstitutionEdgeV1[];
  resolveExerciseIdentity(exerciseRef: ExerciseIdentityV1 | null): ExerciseIdentityResolutionV1;
}

const EMPTY: readonly SubstitutionEdgeV1[] = Object.freeze([]);

function compareEdges(a: SubstitutionEdgeV1, b: SubstitutionEdgeV1): number {
  return a.substitutionPriority - b.substitutionPriority || (a.substituteExerciseRef < b.substituteExerciseRef ? -1 : a.substituteExerciseRef > b.substituteExerciseRef ? 1 : 0);
}

/**
 * Pure, deterministic lookups over one catalog value. The indexes are
 * private to the returned closure (no global mutable map, no runtime
 * registration); every returned object is frozen catalog data.
 */
export function createExerciseEquipmentCatalogLookup(catalog: ExerciseEquipmentCatalogV1): ExerciseEquipmentCatalogLookupV1 {
  const frozen = deepFreeze(catalog);
  const exercises = new Map(frozen.exercises.map((e) => [e.exerciseRef, e]));
  const equipment = new Map(frozen.equipment.map((e) => [e.equipmentId, e]));
  const edges = new Map<string, readonly SubstitutionEdgeV1[]>();
  for (const edge of frozen.substitutions) edges.set(edge.sourceExerciseRef, [...(edges.get(edge.sourceExerciseRef) ?? []), edge]);
  for (const [source, list] of edges) edges.set(source, Object.freeze([...list].sort(compareEdges)));

  return Object.freeze({
    version: frozen.version,
    getExerciseDefinition: (exerciseRef: ExerciseIdentityV1) => exercises.get(exerciseRef) ?? null,
    getEquipmentDefinition: (equipmentId: EquipmentIdV1) => equipment.get(equipmentId) ?? null,
    getSubstitutionEdges: (sourceExerciseRef: ExerciseIdentityV1) => edges.get(sourceExerciseRef) ?? EMPTY,
    resolveExerciseIdentity: (exerciseRef: ExerciseIdentityV1 | null): ExerciseIdentityResolutionV1 => {
      if (exerciseRef === null) return { kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "NULL_EXERCISE_REF" };
      const definition = exercises.get(exerciseRef);
      return definition === undefined ? { kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "UNKNOWN_EXERCISE_REF" } : { kind: "CATALOG_EXERCISE", definition };
    },
  });
}

/** Lookups over THE canonical catalog. */
export const exerciseEquipmentCatalogV1: ExerciseEquipmentCatalogLookupV1 = createExerciseEquipmentCatalogLookup(EXERCISE_EQUIPMENT_CATALOG_V1);
