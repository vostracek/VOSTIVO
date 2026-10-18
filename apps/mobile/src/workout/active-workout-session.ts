import type { AvailableTimeApplicationV1, ExternalWeightLoad, PerformedSetCompletionState, SetType, WorkoutPrescriptionV1 } from "@vostivo/domain";

/**
 * The reconstructed shape `getActiveWorkoutSession()` returns — enough to
 * continue logging after a process restart (spec section 35), built
 * entirely from local rows, no network required. Includes runtime state
 * (`drafts`, `restTimer`) alongside performed reality so the UI has a
 * single authoritative source to read on mount (spec section 4/42) rather
 * than assembling it from several independent calls.
 */
export interface ActiveWorkoutSession {
  readonly id: string;
  readonly prescription: WorkoutPrescriptionV1;
  /**
   * Available-Time Adaptation V1 Slice C — the immutable provenance of an
   * adjusted session ("started as the available-time/v1 adjustment of this
   * planned workout"); `prescription` is then already the adjusted
   * snapshot. `null` for every ordinary session.
   */
  readonly availableTimeApplication: AvailableTimeApplicationV1 | null;
  readonly startedAt: string;
  readonly exercises: readonly ActivePerformedExercise[];
  readonly drafts: readonly SetDraftV1[];
  readonly restTimer: RestTimerStateV1 | null;
}

/**
 * In-progress, not-yet-completed load/reps input (spec section 33/34) —
 * never canonical `PerformedSet` reality. Keyed by the prescription's own
 * ids, which exist before any `PerformedSet` row does.
 */
export interface SetDraftV1 {
  readonly prescriptionExerciseId: string;
  readonly prescriptionSetId: string;
  readonly draftReps: number | null;
  readonly draftLoad: ExternalWeightLoad | null;
}

/**
 * Durable rest-timer state (spec section 19) — `startedAt` +
 * `durationSeconds`, never a decrementing counter; remaining time is
 * always derived as `durationSeconds - (now - startedAt)`.
 */
export interface RestTimerStateV1 {
  readonly startedAt: string;
  readonly durationSeconds: number;
}

export interface ActivePerformedExercise {
  readonly id: string;
  readonly prescriptionExerciseId: string | null;
  readonly displayName: string;
  readonly order: number;
  readonly sets: readonly ActivePerformedSet[];
}

export interface ActivePerformedSet {
  readonly id: string;
  readonly prescriptionSetId: string | null;
  readonly order: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
  readonly setType: SetType;
  readonly completionState: PerformedSetCompletionState;
  readonly completedAt: string | null;
  readonly revision: number;
}
