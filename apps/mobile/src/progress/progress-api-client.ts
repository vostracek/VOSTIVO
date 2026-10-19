import type { ExerciseHistoryPageV1, ProgressOverviewV1, WorkoutHistoryDetailV1, WorkoutHistoryPageV1 } from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";

/**
 * Progress & Feedback V1 — Slice B: the only place Progress HTTP calls
 * happen. Read only. Never sends an athlete id — the server derives the
 * owner from the token. Cursors are opaque: passed back verbatim as
 * `before`, never decoded or built here.
 */
export interface ProgressApiClient {
  getOverview(): Promise<ProgressOverviewV1>;
  getWorkoutHistory(before: string | null): Promise<WorkoutHistoryPageV1>;
  getWorkoutDetail(workoutSessionId: string): Promise<WorkoutHistoryDetailV1>;
  getExerciseHistory(exerciseRef: string, before: string | null): Promise<ExerciseHistoryPageV1>;
}

/** A non-2xx answer. 404 deliberately covers unknown, foreign and non-visible history alike — the UI never says which. */
export class ProgressApiFailure extends Error {
  constructor(readonly status: number) {
    super(`Progress API request failed: ${status}`);
  }
}

export function isProgressNotFound(error: unknown): boolean {
  return error instanceof ProgressApiFailure && error.status === 404;
}

export const PROGRESS_HISTORY_PAGE_SIZE = 20;

export class FetchProgressApiClient implements ProgressApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  getOverview(): Promise<ProgressOverviewV1> {
    return this.getJson<ProgressOverviewV1>("/api/v1/progress");
  }

  getWorkoutHistory(before: string | null): Promise<WorkoutHistoryPageV1> {
    return this.getJson<WorkoutHistoryPageV1>(`/api/v1/progress/workouts${pageQuery(before)}`);
  }

  getWorkoutDetail(workoutSessionId: string): Promise<WorkoutHistoryDetailV1> {
    return this.getJson<WorkoutHistoryDetailV1>(`/api/v1/progress/workouts/${encodeURIComponent(workoutSessionId)}`);
  }

  getExerciseHistory(exerciseRef: string, before: string | null): Promise<ExerciseHistoryPageV1> {
    return this.getJson<ExerciseHistoryPageV1>(`/api/v1/progress/exercises/${encodeURIComponent(exerciseRef)}${pageQuery(before)}`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const accessToken = await this.authTokenProvider.getAccessToken();
    const response = await fetch(`${this.apiBaseUrl}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new ProgressApiFailure(response.status);
    return (await response.json()) as T;
  }
}

/** `limit` + the server's cursor, untouched (only URL-encoded for transport). */
export function pageQuery(before: string | null): string {
  const params = [`limit=${PROGRESS_HISTORY_PAGE_SIZE}`];
  if (before !== null) params.push(`before=${encodeURIComponent(before)}`);
  return `?${params.join("&")}`;
}
