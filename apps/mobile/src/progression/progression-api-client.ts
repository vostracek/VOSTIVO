import type {
  ApplyProgressionApplicationRequestV1,
  KeepOriginalProgressionApplicationRequestV1,
  PendingProgressionApplicationsResponseV1,
  ProgressionApplicationCommandResponseV1,
  ProgressionApplicationProposalResponseV1,
} from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";

/**
 * Progression Application V1 — Slice E — the one place progression HTTP
 * calls happen, mirroring `PlanApiClient`'s exact shape/conventions (same
 * `AuthTokenProvider` boundary, no second networking pattern introduced).
 * Server remains sole authority (task §8): mobile never sends `userId`,
 * mode, `exerciseRef`, `appliedLoad`, `status`, or `actorType` — the
 * request bodies below are literally incapable of carrying them (Slice D's
 * own contracts already exclude them at the type level).
 */
export interface ProgressionApiClient {
  getPending(): Promise<PendingProgressionApplicationsResponseV1>;
  getProposal(applicationId: string): Promise<ProgressionApplicationProposalResponseV1>;
  apply(applicationId: string, request: ApplyProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1>;
  keepOriginal(applicationId: string, request: KeepOriginalProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1>;
}

/**
 * Carries the parsed HTTP status AND the server's own error-envelope
 * `message` (task §20's `MODE_ACTION_NOT_ALLOWED` vs `COMMAND_CONFLICT`
 * are both HTTP 409 — the status alone cannot distinguish them; see
 * `progression-outcome-mapping.ts`'s `mapHttpErrorToUiOutcome`, the only
 * intended consumer of this class's `message`).
 */
export class ProgressionApiRequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FetchProgressionApiClient implements ProgressionApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  getPending(): Promise<PendingProgressionApplicationsResponseV1> {
    return this.getJson<PendingProgressionApplicationsResponseV1>("/api/v1/progression/applications/pending");
  }

  getProposal(applicationId: string): Promise<ProgressionApplicationProposalResponseV1> {
    return this.getJson<ProgressionApplicationProposalResponseV1>(`/api/v1/progression/applications/${encodeURIComponent(applicationId)}/proposal`);
  }

  apply(applicationId: string, request: ApplyProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1> {
    return this.postJson<ProgressionApplicationCommandResponseV1>(`/api/v1/progression/applications/${encodeURIComponent(applicationId)}/apply`, request);
  }

  keepOriginal(applicationId: string, request: KeepOriginalProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1> {
    return this.postJson<ProgressionApplicationCommandResponseV1>(`/api/v1/progression/applications/${encodeURIComponent(applicationId)}/keep-original`, request);
  }

  private async getJson<T>(path: string): Promise<T> {
    const accessToken = await this.authTokenProvider.getAccessToken();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return this.parseResponse<T>(response);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const accessToken = await this.authTokenProvider.getAccessToken();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `Progression API request failed: ${response.status}`;
      try {
        const parsed: unknown = await response.json();
        if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof (parsed as { message: unknown }).message === "string") {
          message = (parsed as { message: string }).message;
        }
      } catch {
        // The error envelope is always JSON in practice (ErrorEnvelopeFilter) — if parsing
        // ever fails, the generic status-based message above is still a safe fallback.
      }
      throw new ProgressionApiRequestFailure(message, response.status);
    }
    return (await response.json()) as T;
  }
}
