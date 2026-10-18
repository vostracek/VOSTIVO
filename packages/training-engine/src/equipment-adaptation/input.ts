import type { EquipmentIdV1, ExerciseIdentityV1, ExternalWeightLoad, RepTargetV1, SetType } from "@vostivo/domain";
import type { PriorityTierV1 } from "../available-time/vocabulary.js";
import type { PrescriptionCompatibilityV1, SubstituteCompatibilityTierV1, SubstitutionPolicyV1 } from "./vocabulary.js";

/**
 * A stable equipment identity — the canonical Exercise & Equipment
 * Reference Catalog V1 vocabulary (`@vostivo/domain`). Compared ONLY by id,
 * never by a user-facing name.
 */
export type { EquipmentIdV1 };

/**
 * One CURATED substitute candidate for one authored exercise. The engine
 * never invents candidates (no name/muscle/similarity search, no AI): it only
 * decides whether a supplied candidate is usable in today's context.
 */
export interface SubstituteCandidateV1 {
  /** The substitute's OWN exercise identity — history/performance stays with it, never with the authored exercise. */
  readonly substituteExerciseId: ExerciseIdentityV1;
  readonly compatibilityTier: SubstituteCompatibilityTierV1;
  /** Explicit curated rank: positive integer, lower = better. Never row order, name or id order. */
  readonly substitutionPriority: number;
  /** Every equipment id the substitute needs (empty = needs none). */
  readonly requiredEquipmentIds: readonly EquipmentIdV1[];
  readonly prescriptionCompatibility: PrescriptionCompatibilityV1;
}

/**
 * One planned set, as the authored prescription carries it. RIR/effort is
 * not represented: no planned RIR exists in the domain model yet
 * (`PlannedSet`, spec §13), so there is nothing to preserve or drop.
 */
export interface EquipmentAdaptationSetV1 {
  readonly plannedSetId: string;
  readonly order: number;
  readonly setType: SetType;
  readonly targetReps: RepTargetV1 | null;
  readonly restSeconds: number | null;
  /** The AUTHORED exercise's load — the engine never carries it over to a substitute (working or warm-up). */
  readonly targetLoad: ExternalWeightLoad | null;
}

/** One planned exercise of TODAY's session, in authored order. */
export interface EquipmentAdaptationExerciseV1 {
  readonly plannedExerciseId: string;
  /** The authored exercise identity (`PlannedExercise.exerciseRef`). */
  readonly exerciseId: ExerciseIdentityV1;
  /** Authored position — the only ordering authority. A substitute takes exactly this position. */
  readonly order: number;
  readonly requiredEquipmentIds: readonly EquipmentIdV1[];
  readonly substitutionPolicy: SubstitutionPolicyV1;
  readonly sets: readonly EquipmentAdaptationSetV1[];
  /**
   * Available-Time authored values, carried through UNCHANGED for a
   * preserved prescription. They never influence substitute compatibility or
   * ranking (a different responsibility). `null` = not authored.
   */
  readonly availableTime: { readonly priorityTier: PriorityTierV1; readonly minimumWorkingSets: number } | null;
  /** Curated candidates for THIS exercise (any order — ranking is `substitutionPriority`). */
  readonly candidates: readonly SubstituteCandidateV1[];
}

/**
 * The narrowest input: today's session + the explicit equipment context
 * for THIS session only. The engine never reads a profile, gym, device,
 * location or clock. Deliberately absent: athlete mode (GUIDED/ADAPTIVE/
 * EXPERT get the same recommendation), "machine occupied" (a reorder
 * concern, not unavailability), progression state, Athlete Memory.
 */
export interface EquipmentAdaptationInputV1 {
  readonly exercises: readonly EquipmentAdaptationExerciseV1[];
  /** Equipment available for THIS session (TODAY_ONLY) — never a permanent gym setup. */
  readonly availableEquipmentIds: readonly EquipmentIdV1[];
  /** Exercises the athlete explicitly never wants (caller-supplied preference) — ineligible as substitutes. */
  readonly athleteBlockedExerciseIds: readonly ExerciseIdentityV1[];
}
