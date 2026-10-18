import type { ExternalWeightLoad } from "../load/load.js";
import type { RepTargetV1 } from "../rep-target.js";
import type { SetType } from "./set-type.js";

/**
 * A narrow, versioned, already-resolved contract representing the workout
 * the athlete intends to perform. Deliberately NOT `Program` /
 * `ProgramVersion` / `TrainingBlock` / `TrainingCycle` — those belong to
 * the future Plan vertical slice. Workout Data Integrity only *consumes*
 * this shape; it must work identically however the prescription was
 * produced (by a coach, a future Training Engine, or hand-entered).
 *
 * `schemaVersion` exists so a later, richer prescription contract (V2) can
 * coexist with historical V1 snapshots already stored on old sessions —
 * see WorkoutSession: the snapshot is immutable once a session starts.
 */
export interface WorkoutPrescriptionV1 {
  readonly schemaVersion: 1;
  readonly prescriptionId: string;
  readonly name: string;
  readonly exercises: readonly PrescribedExerciseV1[];
}

/**
 * `exerciseRef` is an opaque, optional pointer into a future exercise
 * catalog — deliberately not resolved/validated here (spec section 4/10:
 * this slice does not implement Exercise Taxonomy). `displayName` is a
 * historical-readability snapshot: even if the future catalog entry is
 * renamed or removed, this session's history still reads correctly.
 */
export interface PrescribedExerciseV1 {
  readonly prescriptionExerciseId: string;
  readonly exerciseRef: string | null;
  readonly displayName: string;
  readonly order: number;
  readonly sets: readonly PrescribedSetV1[];
  /**
   * Temporary Equipment / Gym Adaptation V1 Slice C — present ONLY when
   * this exercise is a TODAY_ONLY equipment substitute: `exerciseRef`/
   * `displayName` above are then the PERFORMED (substitute) identity, and
   * this records the AUTHORED identity + why + which application decided
   * it. Absent on every ordinary exercise (fully backward compatible).
   */
  readonly substitution?: PrescribedExerciseSubstitutionV1;
}

/**
 * Authored vs performed identity for a temporary equipment substitution:
 * the prescription slot (`prescriptionExerciseId`) stays the authored
 * PlannedExercise; `exerciseRef` is what is actually performed (so history
 * and Previous belong to the substitute); this keeps the authored intent.
 */
export interface PrescribedExerciseSubstitutionV1 {
  readonly kind: "TEMPORARY_EQUIPMENT";
  readonly reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE";
  readonly authoredExerciseRef: string;
  readonly authoredDisplayName: string;
  readonly equipmentApplicationId: string;
  readonly policyVersion: "equipment-adaptation/v1";
  readonly catalogVersion: string;
}

/**
 * `targetReps` preserves the full `RepTargetV1` (exact or range) — this
 * immutable snapshot must not discard the upper bound of a range (Plan
 * Contract Integrity Fix Pass, section 1). There is exactly one
 * authoritative rep-target field here, never a parallel min/max pair.
 */
export interface PrescribedSetV1 {
  readonly prescriptionSetId: string;
  readonly order: number;
  readonly targetReps: RepTargetV1 | null;
  readonly targetLoad: ExternalWeightLoad | null;
  /** See `PlannedSet.restSeconds` (Active Workout Core Logger V1, section 20) — carried through losslessly, same as every other field here. */
  readonly restSeconds: number | null;
  /**
   * Carried through losslessly from `PlannedSet.setType` (Progression
   * Prerequisites V1, docs/domain/PROGRESSION-ENGINE-V1.md §5.2/§6) —
   * required, never null. A workout started with WARM_UP/WORKING/.../...
   * intent must retain that exact intent even if the source Plan later
   * changes (this snapshot is immutable once a session starts, same as
   * every other field here) — set type is never resolved against live
   * Plan state after the fact.
   */
  readonly setType: SetType;
}
