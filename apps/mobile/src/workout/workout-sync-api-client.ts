import { SYNC_OWNER_MISMATCH, type SyncWorkoutCommandsRequest, type SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { RuntimeOwnerMismatchError } from "./auth-token-provider";

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

/** 401 — the server refused this token. `SyncEngine` runs the refresh-once policy (`sendWithAuthRecovery`). */
export class UnauthorizedSyncResponse extends Error {
  constructor() {
    super("Sync request was refused: 401");
    this.name = "UnauthorizedSyncResponse";
  }
}

/**
 * CC-03: the server refused the WHOLE request before processing any command
 * (400/413/422 — global ValidationPipe / body limits, CC01-BATCH-001). This
 * says nothing about which command, if any, is at fault, and is never by
 * itself a reason to treat a command as permanently invalid — `SyncEngine`
 * isolates it (single-command probes) before classifying anything.
 */
export class RequestRejectedSyncResponse extends Error {
  constructor(readonly status: number) {
    super(`Sync request was refused: ${status}`);
    this.name = "RequestRejectedSyncResponse";
  }
}

const REQUEST_REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
/** Throttling / request timeout: the server did not judge the request — retry on the timer. */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

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

    if (response.status >= 500 || TRANSIENT_CLIENT_STATUSES.has(response.status)) {
      throw new TransientSyncFailure(`Server error: ${response.status}`);
    }
    if (response.status === 401) {
      throw new UnauthorizedSyncResponse();
    }
    if (response.status === 409 && (await readErrorMessage(response)) === SYNC_OWNER_MISMATCH) {
      throw new RuntimeOwnerMismatchError();
    }
    if (REQUEST_REJECTED_STATUSES.has(response.status)) {
      throw new RequestRejectedSyncResponse(response.status);
    }
    if (!response.ok) {
      throw new Error(`Sync request failed: ${response.status}`);
    }

    return (await response.json()) as SyncWorkoutCommandsResponse;
  }
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : undefined;
  } catch {
    return undefined;
  }
}
