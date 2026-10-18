import { err, ok, type Result } from "../result.js";
import type { PrescribedExerciseSubstitutionV1, WorkoutPrescriptionV1 } from "./prescription.js";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C: read the exercise
 * identity a (UNTRUSTED) PLANNED START snapshot claims for every slot —
 * the prescription slot, the performed `exerciseRef` and the optional
 * temporary-equipment substitution provenance. Every level is checked at
 * runtime — a hostile shape is a clean `err`, never a throw. It proves only
 * well-formedness; the server then compares every slot against its own
 * authoritative effective prescription (it never trusts the claim).
 *
 * The substitution object is STRICT: exactly the
 * `PrescribedExerciseSubstitutionV1` fields, each a non-empty string, with
 * the fixed kind / reason / policy — a missing, extra or inconsistent field
 * is `MALFORMED_SUBSTITUTION`.
 */
export interface SnapshotExerciseIdentityV1 {
  readonly prescriptionExerciseId: string;
  /** What the snapshot says is performed (`null` = a freeform, non-catalog exercise). */
  readonly exerciseRef: string | null;
  /** `null` = no substitution claimed for this slot. */
  readonly substitution: PrescribedExerciseSubstitutionV1 | null;
}

export type SnapshotExerciseIdentityReason = "MALFORMED_EXERCISE_IDENTITY" | "MALFORMED_SUBSTITUTION";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const SUBSTITUTION_KEYS = ["authoredDisplayName", "authoredExerciseRef", "catalogVersion", "equipmentApplicationId", "kind", "policyVersion", "reasonCode"] as const;

function readSubstitution(raw: unknown): PrescribedExerciseSubstitutionV1 | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length !== SUBSTITUTION_KEYS.length || keys.some((key, index) => key !== SUBSTITUTION_KEYS[index])) return null;
  if (
    raw["kind"] !== "TEMPORARY_EQUIPMENT" ||
    raw["reasonCode"] !== "TEMPORARY_EQUIPMENT_UNAVAILABLE" ||
    raw["policyVersion"] !== "equipment-adaptation/v1" ||
    !nonEmpty(raw["authoredExerciseRef"]) ||
    !nonEmpty(raw["authoredDisplayName"]) ||
    !nonEmpty(raw["equipmentApplicationId"]) ||
    !nonEmpty(raw["catalogVersion"])
  ) {
    return null;
  }
  return {
    kind: "TEMPORARY_EQUIPMENT",
    reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
    authoredExerciseRef: raw["authoredExerciseRef"],
    authoredDisplayName: raw["authoredDisplayName"],
    equipmentApplicationId: raw["equipmentApplicationId"],
    policyVersion: "equipment-adaptation/v1",
    catalogVersion: raw["catalogVersion"],
  };
}

export function readSnapshotExerciseIdentities(snapshot: WorkoutPrescriptionV1): Result<readonly SnapshotExerciseIdentityV1[], SnapshotExerciseIdentityReason> {
  const rawExercises: unknown = snapshot.exercises;
  if (!Array.isArray(rawExercises)) return err("MALFORMED_EXERCISE_IDENTITY");
  const identities: SnapshotExerciseIdentityV1[] = [];
  for (const exercise of rawExercises) {
    if (!isRecord(exercise) || !nonEmpty(exercise["prescriptionExerciseId"])) return err("MALFORMED_EXERCISE_IDENTITY");
    const exerciseRef = exercise["exerciseRef"];
    if (exerciseRef !== null && !nonEmpty(exerciseRef)) return err("MALFORMED_EXERCISE_IDENTITY");
    if (exercise["substitution"] === undefined) {
      identities.push({ prescriptionExerciseId: exercise["prescriptionExerciseId"], exerciseRef, substitution: null });
      continue;
    }
    const substitution = readSubstitution(exercise["substitution"]);
    // A substitute is always a performed catalog exercise.
    if (substitution === null || exerciseRef === null) return err("MALFORMED_SUBSTITUTION");
    identities.push({ prescriptionExerciseId: exercise["prescriptionExerciseId"], exerciseRef, substitution });
  }
  return ok(identities);
}

/** Whether ANY exercise of the (untrusted) snapshot carries a `substitution` key — an UNPLANNED START may never claim one. Never throws. */
export function snapshotDeclaresSubstitution(snapshot: WorkoutPrescriptionV1): boolean {
  const rawExercises: unknown = snapshot.exercises;
  return Array.isArray(rawExercises) && rawExercises.some((exercise) => isRecord(exercise) && exercise["substitution"] !== undefined);
}
