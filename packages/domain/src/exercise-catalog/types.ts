import type { ExerciseIdentityV1 } from "../exercise-identity.js";
import type { PrescriptionCompatibilityV1, SubstituteCompatibilityTierV1 } from "./vocabulary.js";

/** A canonical, product-level equipment id (e.g. "barbell") — never a user-facing label, brand, model or gym-specific id. */
export type EquipmentIdV1 = string;

export interface EquipmentDefinitionV1 {
  readonly equipmentId: EquipmentIdV1;
  readonly displayLabel: string;
}

/**
 * One catalog-backed exercise. `exerciseRef` IS the canonical exercise
 * identity (`ExerciseIdentityV1`) — no second id system. `requiredEquipmentIds`
 * are ALL-OF requirements; `[]` = equipment-independent (no fake
 * "bodyweight" equipment). No availability, ownership, history or load here.
 */
export interface ExerciseDefinitionV1 {
  readonly exerciseRef: ExerciseIdentityV1;
  readonly displayName: string;
  readonly requiredEquipmentIds: readonly EquipmentIdV1[];
}

/**
 * One EXPLICIT, DIRECTIONAL curated substitution edge: source -> substitute.
 * A -> B never implies B -> A. Contains no load conversion and no history.
 */
export interface SubstitutionEdgeV1 {
  readonly sourceExerciseRef: ExerciseIdentityV1;
  readonly substituteExerciseRef: ExerciseIdentityV1;
  readonly compatibilityTier: SubstituteCompatibilityTierV1;
  /** Positive integer, lower = better, per source. */
  readonly substitutionPriority: number;
  readonly prescriptionCompatibility: PrescriptionCompatibilityV1;
}

export interface ExerciseEquipmentCatalogV1 {
  readonly version: string;
  readonly equipment: readonly EquipmentDefinitionV1[];
  readonly exercises: readonly ExerciseDefinitionV1[];
  readonly substitutions: readonly SubstitutionEdgeV1[];
}
