import type { ExerciseEquipmentCatalogLookupV1, ExerciseIdentityV1 } from "@vostivo/domain";
import type { EquipmentIdV1, SubstituteCandidateV1 } from "./input.js";

/**
 * Exercise & Equipment Reference Catalog V1 -> `equipment-adaptation/v1`
 * input facts. Lives at the training-engine boundary (training-engine
 * depends on domain, never the reverse — no cycle).
 *
 * Pure mapping only: it does NOT run the policy and does NOT pre-filter by
 * today's equipment or the athlete's blocks — that eligibility is decided
 * exactly once, inside the policy (which also yields the precise
 * NO_CURATED vs NO_AVAILABLE reasons). Candidates come solely from explicit
 * curated edges: never name/muscle/similarity inference.
 *
 * NULL/UNKNOWN EXERCISES ARE NOT AUTO-ADAPTED: they map to
 * UNSUPPORTED_EXERCISE_IDENTITY — never "no equipment needed", never matched
 * by display name. (The server's fail-closed mapping is Slice B.)
 */
export type CatalogEquipmentFactsV1 =
  | {
      readonly kind: "SUPPORTED";
      readonly exerciseId: ExerciseIdentityV1;
      /** ALL-OF; `[]` = equipment-independent. */
      readonly requiredEquipmentIds: readonly EquipmentIdV1[];
      /** Every curated outgoing edge, ordered by explicit priority (then ref) — not declaration order. */
      readonly candidates: readonly SubstituteCandidateV1[];
    }
  | { readonly kind: "UNSUPPORTED_EXERCISE_IDENTITY"; readonly reason: "NULL_EXERCISE_REF" | "UNKNOWN_EXERCISE_REF" };

export function catalogEquipmentFacts(catalog: ExerciseEquipmentCatalogLookupV1, exerciseRef: ExerciseIdentityV1 | null): CatalogEquipmentFactsV1 {
  const identity = catalog.resolveExerciseIdentity(exerciseRef);
  if (identity.kind === "UNSUPPORTED_EXERCISE_IDENTITY") return identity;
  const candidates: SubstituteCandidateV1[] = [];
  for (const edge of catalog.getSubstitutionEdges(identity.definition.exerciseRef)) {
    const substitute = catalog.getExerciseDefinition(edge.substituteExerciseRef);
    // A validated catalog never has a dangling target; if one ever did, it is simply not a candidate (fail closed).
    if (substitute === null) continue;
    candidates.push({
      substituteExerciseId: substitute.exerciseRef,
      compatibilityTier: edge.compatibilityTier,
      substitutionPriority: edge.substitutionPriority,
      requiredEquipmentIds: [...substitute.requiredEquipmentIds],
      prescriptionCompatibility: edge.prescriptionCompatibility,
    });
  }
  return { kind: "SUPPORTED", exerciseId: identity.definition.exerciseRef, requiredEquipmentIds: [...identity.definition.requiredEquipmentIds], candidates };
}
