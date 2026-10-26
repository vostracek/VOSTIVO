import type { AvailableTimePreviewRequestV1, AvailableTimePreviewResponseV1, PlanOverviewV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";
import { authorizedFetch } from "../workout/authorized-request";

/**
 * The one place Plan HTTP calls happen (spec section 26) — screens never
 * call `fetch` directly. Reuses the same `AuthTokenProvider` boundary as
 * the workout sync client, and the same 401 refresh-once policy
 * (`authorizedFetch`) — there is no authentication bypass here.
 */
export interface PlanApiClient {
  getCurrentPlan(): Promise<PlanOverviewV1>;
  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1>;
  /** Available-Time Slice B's read-only server preview — the only authority for the adjusted structure. */
  previewAvailableTime(plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1>;
}

export class PlanApiRequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FetchPlanApiClient implements PlanApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  getCurrentPlan(): Promise<PlanOverviewV1> {
    return this.getJson<PlanOverviewV1>("/api/v1/plan/current");
  }

  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1> {
    return this.getJson<WorkoutPreviewV1>(`/api/v1/plan/workouts/${encodeURIComponent(plannedWorkoutId)}`);
  }

  previewAvailableTime(plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1> {
    const body: AvailableTimePreviewRequestV1 = { availableMinutes };
    return this.postJson<AvailableTimePreviewResponseV1>(`/api/v1/plan/workouts/${encodeURIComponent(plannedWorkoutId)}/available-time-preview`, body);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await authorizedFetch(this.authTokenProvider, `${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new PlanApiRequestFailure(`Plan API request failed: ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await authorizedFetch(this.authTokenProvider, `${this.apiBaseUrl}${path}`);
    if (!response.ok) {
      throw new PlanApiRequestFailure(`Plan API request failed: ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }
}
