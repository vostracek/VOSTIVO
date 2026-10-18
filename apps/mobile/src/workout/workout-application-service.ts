import type { AvailableTimeApplicationV1, ExerciseIdentityV1, ExternalWeightLoad, WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { ActiveWorkoutSession, RestTimerStateV1 } from "./active-workout-session";
import type {
  CompleteSetInput,
  CompleteSetOutcome,
  FinishWorkoutSessionOutcome,
  PreviousSetPerformance,
  ReopenSetOutcome,
  StartWorkoutSessionOutcome,
  WorkoutRepository,
} from "./workout-repository";
import type { SyncEngine, SyncPendingCommandsResult } from "./sync-engine";

export interface SetDraftUpdate {
  readonly workoutSessionId: string;
  readonly prescriptionExerciseId: string;
  readonly prescriptionSetId: string;
  readonly draftReps: number | null;
  readonly draftLoad: ExternalWeightLoad | null;
}

/**
 * The framework-independent application boundary the Active Workout UI
 * calls (spec section 37/42). No React here, no SQL here — this is plain
 * business/persistence orchestration, safe to unit test without rendering
 * anything.
 */
export class WorkoutApplicationService {
  constructor(
    private readonly repository: WorkoutRepository,
    private readonly syncEngine: SyncEngine,
  ) {}

  startWorkoutSession(
    prescription: WorkoutPrescriptionV1,
    availableTimeApplication: AvailableTimeApplicationV1 | null = null,
  ): Promise<StartWorkoutSessionOutcome> {
    return this.repository.startWorkoutSession(prescription, availableTimeApplication);
  }

  getActiveWorkoutSession(): Promise<ActiveWorkoutSession | undefined> {
    return this.repository.getActiveWorkoutSession();
  }

  /**
   * Completes a set through the real WDI transaction, then starts the
   * rest timer with the caller-resolved duration (spec section 19 —
   * "completing a set starts an exercise-specific rest timer"). The UI
   * resolves `restSeconds` via `resolveRestDuration()`
   * (`workout/rest-timer.ts`), which is the one centralized place the
   * prescription-vs-default fallback decision lives. The rest timer is
   * only started when the set actually completed — never for a session
   * the local terminal invariant already rejected (spec section 5).
   */
  async completeSet(input: CompleteSetInput, restSeconds: number): Promise<CompleteSetOutcome> {
    const outcome = await this.repository.completeSet(input);
    if (outcome.status === "COMPLETED") {
      await this.repository.startRestTimer(input.workoutSessionId, restSeconds);
    }
    return outcome;
  }

  reopenSet(performedSetId: string): Promise<ReopenSetOutcome> {
    return this.repository.reopenSet(performedSetId);
  }

  finishWorkoutSession(workoutSessionId: string): Promise<FinishWorkoutSessionOutcome> {
    return this.repository.finishWorkoutSession(workoutSessionId);
  }

  saveSetDraft(input: SetDraftUpdate): Promise<void> {
    return this.repository.saveSetDraft(input);
  }

  startRestTimer(workoutSessionId: string, durationSeconds: number): Promise<RestTimerStateV1> {
    return this.repository.startRestTimer(workoutSessionId, durationSeconds);
  }

  adjustRestTimer(workoutSessionId: string, deltaSeconds: number): Promise<RestTimerStateV1 | undefined> {
    return this.repository.adjustRestTimer(workoutSessionId, deltaSeconds);
  }

  getPreviousExercisePerformance(
    exerciseRef: ExerciseIdentityV1 | null,
    excludingSessionId: string,
  ): Promise<readonly PreviousSetPerformance[] | undefined> {
    return this.repository.getPreviousExercisePerformance(exerciseRef, excludingSessionId);
  }

  syncPendingWorkoutCommands(): Promise<SyncPendingCommandsResult> {
    return this.syncEngine.syncPendingCommands();
  }
}
