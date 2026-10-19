import { WorkoutRepository } from "../workout/workout-repository";
import { DEFAULT_BATCH_SIZE, SyncEngine } from "../workout/sync-engine";
import { WorkoutSyncCoordinator, type WorkoutSyncLogger } from "../infrastructure/workout-sync-coordinator";
import { FetchWorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import { WorkoutApplicationService } from "../workout/workout-application-service";
import { AdjustedWorkoutStartService } from "../workout/adjusted-workout-start";
import type { AvailableTimeFlowPorts } from "../available-time/available-time-controller";
import { createPlanAuthTokenProvider, getPlanApiBaseUrl } from "../infrastructure/plan-runtime-config";
import { FetchProgressionApiClient, type ProgressionApiClient } from "../progression/progression-api-client";
import { FetchGuidedLoadingSetupApiClient, type GuidedLoadingSetupApiClient } from "../progression/guided-loading-setup-api-client";
import { FetchMissedWorkoutApiClient } from "../missed-workout/missed-workout-api-client";
import type { MissedWorkoutFlowPorts } from "../missed-workout/missed-workout-controller";
import { FetchEquipmentApiClient } from "../equipment/equipment-api-client";
import type { EquipmentFlowPorts } from "../equipment/equipment-controller";
import { FetchMeApiClient } from "../profile/me-api-client";
import { TrainingTimeZoneBootstrapper, readDeviceTimeZone } from "../profile/training-time-zone-bootstrap";
import { FetchProgressApiClient, type ProgressApiClient } from "../progress/progress-api-client";
import { FetchPlanApiClient } from "./plan-api-client";
import { PlanApplicationService } from "./plan-application-service";

/**
 * Single composition root for the Plan/Preview/Active-Workout/Today
 * screens — screens import `planApplicationService`/
 * `workoutApplicationService`/`progressionApiClient` from here, they
 * never construct their own repository/sync/API-client graph (spec
 * section 26/40: no duplicated business state, one real boundary).
 * Lazily constructed so importing this module has no side effect until a
 * screen actually renders.
 *
 * `ProgressionApiClient` (Slice E) has no `WorkoutSessionGateway`-style
 * second collaborator to compose (unlike `PlanApplicationService`), so it
 * is exposed directly — an identical pass-through `ProgressionApplicationService`
 * class would add a layer with no behavior of its own.
 */
let cachedWorkoutApplicationService: WorkoutApplicationService | undefined;
let cachedWorkoutSyncCoordinator: WorkoutSyncCoordinator | undefined;
let cachedPlanApplicationService: PlanApplicationService | undefined;
let cachedProgressionApiClient: ProgressionApiClient | undefined;
let cachedGuidedLoadingSetupApiClient: GuidedLoadingSetupApiClient | undefined;
let cachedAdjustedWorkoutStartService: AdjustedWorkoutStartService | undefined;
let cachedAvailableTimeFlowPorts: AvailableTimeFlowPorts | undefined;
let cachedTrainingTimeZoneBootstrapper: TrainingTimeZoneBootstrapper | undefined;
let cachedMissedWorkoutFlowPorts: MissedWorkoutFlowPorts | undefined;
let cachedEquipmentFlowPorts: EquipmentFlowPorts | undefined;
let cachedProgressApiClient: ProgressApiClient | undefined;

export function getWorkoutApplicationService(): WorkoutApplicationService {
  cachedWorkoutApplicationService ??= buildWorkoutApplicationService();
  return cachedWorkoutApplicationService;
}

/**
 * The one workout sync coordinator for the app's lifetime: every trigger
 * (Active Workout mutations, launch, foreground, network regain, retry)
 * goes through it, so there is a single in-flight sync and a single retry
 * timer. Module-level like the services above, so screen remounts and
 * Fast Refresh of a screen never create a second one.
 */
export function getWorkoutSyncCoordinator(): WorkoutSyncCoordinator {
  cachedWorkoutSyncCoordinator ??= new WorkoutSyncCoordinator(
    () => getWorkoutApplicationService().syncPendingWorkoutCommands(),
    { batchSize: DEFAULT_BATCH_SIZE, logger: __DEV__ ? devSyncLogger : undefined },
  );
  return cachedWorkoutSyncCoordinator;
}

// DEV-only: counts, triggers and delays — never tokens or workout payloads.
const devSyncLogger: WorkoutSyncLogger = {
  debug: (message, details) => console.debug(`[workout-sync] ${message}`, details ?? {}),
};

/** Available-Time Adaptation V1 Slice C — the local-first adjusted START (used by the Slice D sheet). */
export function getAdjustedWorkoutStartService(): AdjustedWorkoutStartService {
  cachedAdjustedWorkoutStartService ??= new AdjustedWorkoutStartService(getWorkoutApplicationService(), getWorkoutSyncCoordinator());
  return cachedAdjustedWorkoutStartService;
}

/** Available-Time Adaptation V1 Slice D — the sheet's ports, all existing services (stable identity). */
export function getAvailableTimeFlowPorts(): AvailableTimeFlowPorts {
  cachedAvailableTimeFlowPorts ??= {
    previewAvailableTime: (plannedWorkoutId, availableMinutes) => getPlanApplicationService().previewAvailableTime(plannedWorkoutId, availableMinutes),
    getWorkoutPreview: (plannedWorkoutId) => getPlanApplicationService().getWorkoutPreview(plannedWorkoutId),
    startWorkout: (workoutPreview) => getPlanApplicationService().startWorkout(workoutPreview),
    startAdjustedWorkout: (input) => getAdjustedWorkoutStartService().startAdjustedWorkout(input),
    requestSync: (trigger) => getWorkoutSyncCoordinator().requestSync(trigger),
  };
  return cachedAvailableTimeFlowPorts;
}

/**
 * Missed Workout V1 Slice D — the ONE training time zone bootstrapper for the
 * app process (at most one run; a saved zone is never overwritten).
 */
export function getTrainingTimeZoneBootstrapper(): TrainingTimeZoneBootstrapper {
  if (cachedTrainingTimeZoneBootstrapper === undefined) {
    const me = new FetchMeApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
    cachedTrainingTimeZoneBootstrapper = new TrainingTimeZoneBootstrapper({
      getMe: () => me.getMe(),
      setTrainingTimeZone: (zone) => me.setTrainingTimeZone(zone),
      deviceTimeZone: readDeviceTimeZone,
      logFailure: logTechnicalFailure,
    });
  }
  return cachedTrainingTimeZoneBootstrapper;
}

/** Missed Workout V1 Slice D — Today's flow ports (stable identity). */
export function getMissedWorkoutFlowPorts(): MissedWorkoutFlowPorts {
  if (cachedMissedWorkoutFlowPorts === undefined) {
    const api = new FetchMissedWorkoutApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
    cachedMissedWorkoutFlowPorts = {
      ensureTrainingTimeZone: () => getTrainingTimeZoneBootstrapper().ensure(),
      retryTrainingTimeZone: () => getTrainingTimeZoneBootstrapper().retry(),
      preview: () => api.preview(),
      apply: (previewFingerprint) => api.apply(previewFingerprint),
    };
  }
  return cachedMissedWorkoutFlowPorts;
}

/**
 * Temporary Equipment V1 Slice D — the equipment sheet's ports (stable
 * identity): the equipment API, the EXISTING Workout Preview read (the
 * server's effective prescription) and the EXISTING time zone bootstrapper.
 * There is deliberately no start port: Apply never starts a workout.
 */
export function getEquipmentFlowPorts(): EquipmentFlowPorts {
  if (cachedEquipmentFlowPorts === undefined) {
    const api = new FetchEquipmentApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
    cachedEquipmentFlowPorts = {
      options: (plannedWorkoutId) => api.options(plannedWorkoutId),
      preview: (request) => api.preview(request),
      apply: (request) => api.apply(request),
      getWorkoutPreview: (plannedWorkoutId) => getPlanApplicationService().getWorkoutPreview(plannedWorkoutId),
      retryTrainingTimeZone: () => getTrainingTimeZoneBootstrapper().retry(),
    };
  }
  return cachedEquipmentFlowPorts;
}

// DEV-only, technical messages only — never tokens, profile or plan data.
export function logTechnicalFailure(message: string): void {
  if (__DEV__) console.warn(`[vostivo] ${message}`);
}

export function getPlanApplicationService(): PlanApplicationService {
  cachedPlanApplicationService ??= buildPlanApplicationService();
  return cachedPlanApplicationService;
}

export function getProgressionApiClient(): ProgressionApiClient {
  cachedProgressionApiClient ??= new FetchProgressionApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
  return cachedProgressionApiClient;
}

export function getGuidedLoadingSetupApiClient(): GuidedLoadingSetupApiClient {
  cachedGuidedLoadingSetupApiClient ??= new FetchGuidedLoadingSetupApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
  return cachedGuidedLoadingSetupApiClient;
}

/** Progress & Feedback V1 Slice B — read-only Progress reads (no second collaborator, so exposed directly like the progression client). */
export function getProgressApiClient(): ProgressApiClient {
  cachedProgressApiClient ??= new FetchProgressApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
  return cachedProgressApiClient;
}

function buildWorkoutApplicationService(): WorkoutApplicationService {
  const repository = new WorkoutRepository();
  const authTokenProvider = createPlanAuthTokenProvider();
  const apiClient = new FetchWorkoutSyncApiClient(getPlanApiBaseUrl());
  const syncEngine = new SyncEngine(repository, authTokenProvider, apiClient);
  return new WorkoutApplicationService(repository, syncEngine);
}

function buildPlanApplicationService(): PlanApplicationService {
  const planApiClient = new FetchPlanApiClient(getPlanApiBaseUrl(), createPlanAuthTokenProvider());
  return new PlanApplicationService(planApiClient, getWorkoutApplicationService());
}
