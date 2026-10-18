import type { ExternalWeightLoad, PlanSessionDisplayStatus, PrescribedExerciseSubstitutionV1, RepTargetV1, WorkoutPrescriptionV1 } from "@vostivo/domain";

/**
 * Explicit read projection for the Workout Preview screen (spec section
 * 22) — never a serialized ORM row. `targetReps` mirrors
 * `PrescribedSetV1.targetReps` exactly (same `RepTargetV1` shape) — one
 * representation of rep-target semantics across the display DTO and the
 * embedded prescription, not two (Plan Contract Integrity Fix Pass,
 * section 2).
 */
export interface WorkoutPreviewSetV1 {
  readonly plannedSetId: string;
  readonly order: number;
  readonly targetReps: RepTargetV1 | null;
  readonly targetLoad: ExternalWeightLoad | null;
  readonly restSeconds: number | null;
}

export interface WorkoutPreviewExerciseV1 {
  readonly plannedExerciseId: string;
  readonly displayName: string;
  readonly order: number;
  readonly sets: readonly WorkoutPreviewSetV1[];
  /**
   * Additive (Temporary Equipment V1 Slice C): present only when today's
   * applied equipment adaptation substitutes this exercise — `displayName`
   * is then the substitute (performed) exercise and this carries the
   * authored identity. The same value is on the prescription exercise.
   */
  readonly substitution?: PrescribedExerciseSubstitutionV1;
}

/**
 * `hasActiveSession`/`canStart` reflect server-observed
 * `app.workout_sessions` state and are informational only — the mobile
 * client's actual Start-vs-Resume decision always queries the local WDI
 * `WorkoutRepository` directly (spec section 33/34), since that is
 * authoritative for what exists on-device right now, independent of sync
 * timing. See docs/architecture/PLAN-PRESCRIPTION.md.
 *
 * `prescription` is the already-resolved `WorkoutPrescriptionV1` for this
 * planned workout (spec section 23/24), built server-side once, at the
 * same time as the rest of this preview — not a second network call at
 * Start-tap time. The mobile Start Workout action passes this value
 * directly to WDI's `startWorkoutSession()`; there is no separate
 * "build the prescription" step or a second prescription-mapping
 * implementation on the client (spec section 23: "do not silently fork
 * prescription representations").
 */
export interface WorkoutPreviewV1 {
  readonly plannedWorkoutId: string;
  readonly name: string;
  readonly focus: string | null;
  readonly estimatedDurationMinutes: number | null;
  readonly displayStatus: PlanSessionDisplayStatus;
  readonly hasActiveSession: boolean;
  readonly canStart: boolean;
  readonly exercises: readonly WorkoutPreviewExerciseV1[];
  readonly prescription: WorkoutPrescriptionV1;
}
