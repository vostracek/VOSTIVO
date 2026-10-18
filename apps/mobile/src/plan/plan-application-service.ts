import type { AvailableTimePreviewResponseV1, PlanOverviewV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { ActiveWorkoutSession } from "../workout/active-workout-session";
import type { StartWorkoutSessionOutcome } from "../workout/workout-repository";
import type { PlanApiClient } from "./plan-api-client";

/**
 * The subset of `WorkoutApplicationService` (Workout Data Integrity) this
 * screen-facing service needs — a real `WorkoutApplicationService`
 * instance satisfies this structurally, no adapter needed. Kept narrow so
 * this file has no native/SQLite import and stays Vitest-testable (spec
 * section 26/40: no fetch calls scattered through presentation
 * components, and PLAN-MOB-005: the Plan layer never owns canonical
 * active-workout state — it only asks WDI, it never stores a copy).
 */
export interface WorkoutSessionGateway {
  getActiveWorkoutSession(): Promise<ActiveWorkoutSession | undefined>;
  startWorkoutSession(prescription: WorkoutPreviewV1["prescription"]): Promise<StartWorkoutSessionOutcome>;
}

/**
 * The single application-layer boundary the Plan/Preview/Today screens
 * call (spec section 25/26) — no screen talks to `PlanApiClient` or WDI
 * directly. `startWorkout` passes the already-fetched
 * `WorkoutPreviewV1.prescription` straight to WDI's real
 * `startWorkoutSession` (spec section 33): no second network call, no
 * parallel prescription-building logic on the client (spec section 23).
 * WDI's own single-active-session guard is what prevents a duplicate
 * start (spec section 34) — this service does not duplicate that check.
 */
export class PlanApplicationService {
  constructor(
    private readonly planApiClient: PlanApiClient,
    private readonly workoutSessionGateway: WorkoutSessionGateway,
  ) {}

  getCurrentPlan(): Promise<PlanOverviewV1> {
    return this.planApiClient.getCurrentPlan();
  }

  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1> {
    return this.planApiClient.getWorkoutPreview(plannedWorkoutId);
  }

  previewAvailableTime(plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1> {
    return this.planApiClient.previewAvailableTime(plannedWorkoutId, availableMinutes);
  }

  getActiveWorkoutSession(): Promise<ActiveWorkoutSession | undefined> {
    return this.workoutSessionGateway.getActiveWorkoutSession();
  }

  startWorkout(preview: WorkoutPreviewV1): Promise<StartWorkoutSessionOutcome> {
    return this.workoutSessionGateway.startWorkoutSession(preview.prescription);
  }
}
