import { WorkoutRepository } from "../workout/workout-repository";
import { DEFAULT_BATCH_SIZE, SyncEngine } from "../workout/sync-engine";
import { WorkoutSyncCoordinator, type WorkoutSyncLogger } from "../infrastructure/workout-sync-coordinator";
import { FetchWorkoutSyncApiClient, type WorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import { WorkoutApplicationService } from "../workout/workout-application-service";
import { AdjustedWorkoutStartService } from "../workout/adjusted-workout-start";
import type { AuthTokenProvider } from "../workout/auth-token-provider";
import type { AvailableTimeFlowPorts } from "../available-time/available-time-controller";
import { FetchProgressionApiClient, type ProgressionApiClient } from "../progression/progression-api-client";
import { FetchGuidedLoadingSetupApiClient, type GuidedLoadingSetupApiClient } from "../progression/guided-loading-setup-api-client";
import { FetchMissedWorkoutApiClient } from "../missed-workout/missed-workout-api-client";
import type { MissedWorkoutFlowPorts } from "../missed-workout/missed-workout-controller";
import { FetchEquipmentApiClient } from "../equipment/equipment-api-client";
import type { EquipmentFlowPorts } from "../equipment/equipment-controller";
import { FetchMeApiClient } from "../profile/me-api-client";
import { TrainingTimeZoneBootstrapper, readDeviceTimeZone } from "../profile/training-time-zone-bootstrap";
import { FetchProgressApiClient, type ProgressApiClient } from "../progress/progress-api-client";
import type { AthleteDatabaseHandle } from "../local-database/athlete-database-handle";
import { FetchPlanApiClient } from "./plan-api-client";
import { PlanApplicationService } from "./plan-application-service";

/**
 * The composition root for ONE verified athlete (Auth & Local Athlete
 * Boundary V1 Slice B). Every service the Plan/Preview/Active-Workout/Today/
 * Progress screens use is constructed here, explicitly bound to exactly one
 * `ownerUserId`: its database handle is that athlete's own encrypted file,
 * its token provider only ever yields that athlete's token, and its sync
 * engine stamps every batch with that owner. Screens reach it only through
 * `useAthleteRuntime()` under the IdentityGate's READY state — there is no
 * module-level singleton that could silently change owner.
 *
 * Still the single composition root per runtime (spec section 26/40: no
 * duplicated business state, one real boundary): screens never construct
 * their own repository/sync/API-client graph.
 */
export interface AthleteRuntime {
  readonly ownerUserId: string;
  readonly workoutApplicationService: WorkoutApplicationService;
  /**
   * The one workout sync coordinator of this runtime: every trigger
   * (Active Workout mutations, launch, foreground, network regain, retry)
   * goes through it, so there is a single in-flight sync and a single retry
   * timer per owner.
   */
  readonly workoutSyncCoordinator: WorkoutSyncCoordinator;
  readonly planApplicationService: PlanApplicationService;
  readonly progressionApiClient: ProgressionApiClient;
  readonly guidedLoadingSetupApiClient: GuidedLoadingSetupApiClient;
  /** Available-Time Adaptation V1 Slice C — the local-first adjusted START (used by the Slice D sheet). */
  readonly adjustedWorkoutStartService: AdjustedWorkoutStartService;
  /** Available-Time Adaptation V1 Slice D — the sheet's ports, all existing services (stable identity). */
  readonly availableTimeFlowPorts: AvailableTimeFlowPorts;
  /** Missed Workout V1 Slice D — the ONE training time zone bootstrapper of this runtime (at most one run; a saved zone is never overwritten). */
  readonly trainingTimeZoneBootstrapper: TrainingTimeZoneBootstrapper;
  /** Missed Workout V1 Slice D — Today's flow ports (stable identity). */
  readonly missedWorkoutFlowPorts: MissedWorkoutFlowPorts;
  /**
   * Temporary Equipment V1 Slice D — the equipment sheet's ports (stable
   * identity). There is deliberately no start port: Apply never starts a
   * workout.
   */
  readonly equipmentFlowPorts: EquipmentFlowPorts;
  /** Progress & Feedback V1 Slice B — read-only Progress reads. */
  readonly progressApiClient: ProgressApiClient;
  /**
   * Stops sync, makes every further local-database access of this runtime
   * fail, and closes the database handle (awaited). The IdentityGate awaits
   * this before it opens another owner's database.
   */
  dispose(): Promise<void>;
}

export interface AthleteRuntimeInput {
  /** The verified `userId` (from `GET /me` or its verified binding). */
  readonly ownerUserId: string;
  readonly database: AthleteDatabaseHandle;
  /** Owner-bound: yields a token only while the session is still this owner's. */
  readonly authTokenProvider: AuthTokenProvider;
  readonly apiBaseUrl: string;
  /** Tests inject a fake transport; the app uses the real `fetch` client. */
  readonly workoutSyncApiClient?: WorkoutSyncApiClient;
  readonly syncLogger?: WorkoutSyncLogger;
}

export class AthleteRuntimeDisposedError extends Error {
  constructor() {
    super("This athlete runtime has been disposed");
    this.name = "AthleteRuntimeDisposedError";
  }
}

export function createAthleteRuntime(input: AthleteRuntimeInput): AthleteRuntime {
  const { ownerUserId, database, authTokenProvider, apiBaseUrl } = input;
  let disposed = false;

  const repository = new WorkoutRepository(() => (disposed ? Promise.reject(new AthleteRuntimeDisposedError()) : Promise.resolve(database.db)));
  const syncEngine = new SyncEngine(ownerUserId, repository, authTokenProvider, input.workoutSyncApiClient ?? new FetchWorkoutSyncApiClient(apiBaseUrl));
  const workoutApplicationService = new WorkoutApplicationService(repository, syncEngine);
  const workoutSyncCoordinator = new WorkoutSyncCoordinator(() => workoutApplicationService.syncPendingWorkoutCommands(), {
    batchSize: DEFAULT_BATCH_SIZE,
    logger: input.syncLogger,
  });
  const planApplicationService = new PlanApplicationService(new FetchPlanApiClient(apiBaseUrl, authTokenProvider), workoutApplicationService);
  const adjustedWorkoutStartService = new AdjustedWorkoutStartService(workoutApplicationService, workoutSyncCoordinator);

  const me = new FetchMeApiClient(apiBaseUrl, authTokenProvider);
  const trainingTimeZoneBootstrapper = new TrainingTimeZoneBootstrapper({
    getMe: () => me.getMe(),
    setTrainingTimeZone: (zone) => me.setTrainingTimeZone(zone),
    deviceTimeZone: readDeviceTimeZone,
    logFailure: logTechnicalFailure,
  });

  const missedWorkoutApi = new FetchMissedWorkoutApiClient(apiBaseUrl, authTokenProvider);
  const equipmentApi = new FetchEquipmentApiClient(apiBaseUrl, authTokenProvider);

  return {
    ownerUserId,
    workoutApplicationService,
    workoutSyncCoordinator,
    planApplicationService,
    progressionApiClient: new FetchProgressionApiClient(apiBaseUrl, authTokenProvider),
    guidedLoadingSetupApiClient: new FetchGuidedLoadingSetupApiClient(apiBaseUrl, authTokenProvider),
    adjustedWorkoutStartService,
    availableTimeFlowPorts: {
      previewAvailableTime: (plannedWorkoutId, availableMinutes) => planApplicationService.previewAvailableTime(plannedWorkoutId, availableMinutes),
      getWorkoutPreview: (plannedWorkoutId) => planApplicationService.getWorkoutPreview(plannedWorkoutId),
      startWorkout: (workoutPreview) => planApplicationService.startWorkout(workoutPreview),
      startAdjustedWorkout: (startInput) => adjustedWorkoutStartService.startAdjustedWorkout(startInput),
      requestSync: (trigger) => workoutSyncCoordinator.requestSync(trigger),
    },
    trainingTimeZoneBootstrapper,
    missedWorkoutFlowPorts: {
      ensureTrainingTimeZone: () => trainingTimeZoneBootstrapper.ensure(),
      retryTrainingTimeZone: () => trainingTimeZoneBootstrapper.retry(),
      preview: () => missedWorkoutApi.preview(),
      apply: (previewFingerprint) => missedWorkoutApi.apply(previewFingerprint),
    },
    equipmentFlowPorts: {
      options: (plannedWorkoutId) => equipmentApi.options(plannedWorkoutId),
      preview: (request) => equipmentApi.preview(request),
      apply: (request) => equipmentApi.apply(request),
      getWorkoutPreview: (plannedWorkoutId) => planApplicationService.getWorkoutPreview(plannedWorkoutId),
      retryTrainingTimeZone: () => trainingTimeZoneBootstrapper.retry(),
    },
    progressApiClient: new FetchProgressApiClient(apiBaseUrl, authTokenProvider),
    async dispose() {
      if (disposed) return;
      disposed = true;
      workoutSyncCoordinator.dispose();
      await database.close();
    },
  };
}

// DEV-only, technical messages only — never tokens, profile or plan data.
export function logTechnicalFailure(message: string): void {
  if (__DEV__) console.warn(`[vostivo] ${message}`);
}
