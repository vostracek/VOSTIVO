import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse } from "@vostivo/contracts";

/**
 * The transport boundary `SyncEngine` depends on — an interface, not a
 * direct `fetch` call, so tests can inject a fake without a real network
 * (spec section 30).
 */
export interface WorkoutSyncApiClient {
  syncCommands(
    accessToken: string,
    request: SyncWorkoutCommandsRequest,
  ): Promise<SyncWorkoutCommandsResponse>;
}

export class TransientSyncFailure extends Error {}

export class FetchWorkoutSyncApiClient implements WorkoutSyncApiClient {
  constructor(private readonly apiBaseUrl: string) {}

  async syncCommands(
    accessToken: string,
    request: SyncWorkoutCommandsRequest,
  ): Promise<SyncWorkoutCommandsResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/api/v1/sync/workout-commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // Network failure (offline, DNS, timeout) — retryable, never a
      // permanent rejection (spec section 33).
      throw new TransientSyncFailure(error instanceof Error ? error.message : String(error));
    }

    if (response.status >= 500) {
      throw new TransientSyncFailure(`Server error: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Sync request failed: ${response.status}`);
    }

    return (await response.json()) as SyncWorkoutCommandsResponse;
  }
}
