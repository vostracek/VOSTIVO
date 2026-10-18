import type { ExerciseEquipmentCatalogV1, SubstitutionEdgeV1 } from "./types.js";
import { EXERCISE_EQUIPMENT_CATALOG_VERSION_V1 } from "./vocabulary.js";
import { deepFreeze } from "./deep-freeze.js";

function equivalent(sourceExerciseRef: string, substituteExerciseRef: string, substitutionPriority: number): SubstitutionEdgeV1 {
  return { sourceExerciseRef, substituteExerciseRef, compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority, prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION" };
}

function compatible(sourceExerciseRef: string, substituteExerciseRef: string, substitutionPriority: number): SubstitutionEdgeV1 {
  return { sourceExerciseRef, substituteExerciseRef, compatibilityTier: "ROLE_COMPATIBLE", substitutionPriority, prescriptionCompatibility: "REQUIRES_PRESCRIPTION_CHANGE" };
}

/**
 * THE canonical, code-owned, version-controlled Exercise & Equipment
 * Reference Catalog V1 — product-authored data, reviewable in Git, shipped
 * with the code (no DB table, CMS or remote lookup). Covers every
 * first-party exerciseRef the product currently authors (the dev Plan seed,
 * incl. SMALL_FIXTURE). Deep-frozen: callers cannot mutate it.
 *
 * Equipment granularity: one id per meaningful, gym-independent
 * availability constraint (a hack squat machine being out never implies
 * "all machines" are). See the spec for the reasoning behind each id.
 *
 * SUBSTITUTIONS — Curated Substitution Seed V1: EXACTLY the tech-lead-
 * approved edges, each explicit and directional (a reverse relation exists
 * only where it is authored below). Never inferred from names, muscles or
 * similarity. ROLE_EQUIVALENT (+ PRESERVE_WORKING_PRESCRIPTION) = may be
 * automatically RECOMMENDED for a temporary, session-only substitution;
 * ROLE_COMPATIBLE (+ REQUIRES_PRESCRIPTION_CHANGE) = review/manual
 * alternative only. Neither transfers load, history or exercise identity,
 * and a program/coach LOCK always overrides catalog equivalence.
 */
export const EXERCISE_EQUIPMENT_CATALOG_V1: ExerciseEquipmentCatalogV1 = deepFreeze({
  version: EXERCISE_EQUIPMENT_CATALOG_VERSION_V1,
  equipment: [
    { equipmentId: "barbell", displayLabel: "Barbell (with plates)" },
    { equipmentId: "barbell-rack", displayLabel: "Barbell rack / uprights" },
    { equipmentId: "flat-bench", displayLabel: "Flat bench" },
    { equipmentId: "adjustable-bench", displayLabel: "Adjustable (incline) bench" },
    { equipmentId: "dumbbells", displayLabel: "Dumbbells" },
    { equipmentId: "cable-station", displayLabel: "Cable station (adjustable pulley)" },
    { equipmentId: "lat-pulldown-station", displayLabel: "Lat pulldown station" },
    { equipmentId: "leg-press-machine", displayLabel: "Leg press machine" },
    { equipmentId: "leg-curl-machine", displayLabel: "Leg curl machine" },
    { equipmentId: "hack-squat-machine", displayLabel: "Hack Squat Machine" },
  ],
  exercises: [
    { exerciseRef: "bench-press", displayName: "Bench Press", requiredEquipmentIds: ["barbell", "barbell-rack", "flat-bench"] },
    { exerciseRef: "overhead-press", displayName: "Overhead Press", requiredEquipmentIds: ["barbell", "barbell-rack"] },
    { exerciseRef: "lat-pulldown", displayName: "Lat Pulldown", requiredEquipmentIds: ["lat-pulldown-station"] },
    { exerciseRef: "back-squat", displayName: "Back Squat", requiredEquipmentIds: ["barbell", "barbell-rack"] },
    { exerciseRef: "romanian-deadlift", displayName: "Romanian Deadlift", requiredEquipmentIds: ["barbell"] },
    { exerciseRef: "leg-press", displayName: "Leg Press", requiredEquipmentIds: ["leg-press-machine"] },
    { exerciseRef: "barbell-row", displayName: "Barbell Row", requiredEquipmentIds: ["barbell"] },
    { exerciseRef: "incline-dumbbell-press", displayName: "Incline Dumbbell Press", requiredEquipmentIds: ["dumbbells", "adjustable-bench"] },
    { exerciseRef: "face-pull", displayName: "Face Pull", requiredEquipmentIds: ["cable-station"] },
    { exerciseRef: "deadlift", displayName: "Deadlift", requiredEquipmentIds: ["barbell"] },
    { exerciseRef: "bulgarian-split-squat", displayName: "Bulgarian Split Squat", requiredEquipmentIds: ["dumbbells", "flat-bench"] },
    { exerciseRef: "leg-curl", displayName: "Leg Curl", requiredEquipmentIds: ["leg-curl-machine"] },
    // Curated Substitution Seed V1 — new canonical exercises.
    { exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", requiredEquipmentIds: ["dumbbells", "flat-bench"] },
    { exerciseRef: "seated-dumbbell-overhead-press", displayName: "Seated Dumbbell Overhead Press", requiredEquipmentIds: ["dumbbells", "adjustable-bench"] },
    { exerciseRef: "cable-lat-pulldown", displayName: "Cable Lat Pulldown", requiredEquipmentIds: ["cable-station"] },
    { exerciseRef: "dumbbell-romanian-deadlift", displayName: "Dumbbell Romanian Deadlift", requiredEquipmentIds: ["dumbbells"] },
    { exerciseRef: "seated-cable-row", displayName: "Seated Cable Row", requiredEquipmentIds: ["cable-station"] },
    { exerciseRef: "chest-supported-dumbbell-row", displayName: "Chest-Supported Dumbbell Row", requiredEquipmentIds: ["dumbbells", "adjustable-bench"] },
    { exerciseRef: "hack-squat", displayName: "Hack Squat", requiredEquipmentIds: ["hack-squat-machine"] },
  ],
  substitutions: [
    // ROLE_EQUIVALENT — automatic recommendation allowed (session-only; load/history never transfer).
    equivalent("bench-press", "dumbbell-bench-press", 1),
    equivalent("dumbbell-bench-press", "bench-press", 1),
    equivalent("overhead-press", "seated-dumbbell-overhead-press", 1),
    equivalent("seated-dumbbell-overhead-press", "overhead-press", 1),
    equivalent("lat-pulldown", "cable-lat-pulldown", 1),
    equivalent("cable-lat-pulldown", "lat-pulldown", 1),
    equivalent("romanian-deadlift", "dumbbell-romanian-deadlift", 1),
    equivalent("dumbbell-romanian-deadlift", "romanian-deadlift", 1),
    equivalent("barbell-row", "seated-cable-row", 1),
    equivalent("barbell-row", "chest-supported-dumbbell-row", 2),
    equivalent("seated-cable-row", "chest-supported-dumbbell-row", 1),
    equivalent("seated-cable-row", "barbell-row", 2),
    equivalent("chest-supported-dumbbell-row", "seated-cable-row", 1),
    equivalent("chest-supported-dumbbell-row", "barbell-row", 2),
    // ROLE_COMPATIBLE — review/manual alternatives only; NEVER automatic.
    compatible("back-squat", "hack-squat", 1),
    compatible("back-squat", "leg-press", 2),
    compatible("leg-press", "hack-squat", 1),
    compatible("leg-press", "back-squat", 2),
    compatible("hack-squat", "leg-press", 1),
    compatible("hack-squat", "back-squat", 2),
    compatible("deadlift", "romanian-deadlift", 1),
    // After bench-press's equivalent candidate (priority 1).
    compatible("bench-press", "incline-dumbbell-press", 10),
  ],
});
