import type {
  GuidedLoadingSetupAttentionResponseV1,
  LoadingSetupContextResponseV1,
  SaveLoadingSetupRequestV1,
  SaveLoadingSetupResultResponseV1,
} from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";
import { authorizedFetch } from "../workout/authorized-request";
import { ProgressionApiRequestFailure } from "./progression-api-client";

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1) — mirrors
 * `progression-api-client.ts`'s exact shape/conventions (same
 * `AuthTokenProvider` boundary, same error-envelope-aware failure class —
 * reused directly rather than a second copy — no new networking pattern).
 * Server remains sole authority (task §8): the request body is
 * structurally incapable of carrying `userId`/mode/`exerciseRef`/
 * `gymProfileId`/`loadingCapabilityId`/unit/basis.
 */
export interface GuidedLoadingSetupApiClient {
  getAttention(): Promise<GuidedLoadingSetupAttentionResponseV1>;
  getContext(applicationId: string): Promise<LoadingSetupContextResponseV1>;
  save(applicationId: string, request: SaveLoadingSetupRequestV1): Promise<SaveLoadingSetupResultResponseV1>;
}

export class FetchGuidedLoadingSetupApiClient implements GuidedLoadingSetupApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  getAttention(): Promise<GuidedLoadingSetupAttentionResponseV1> {
    return this.getJson<GuidedLoadingSetupAttentionResponseV1>("/api/v1/progression/guided-loading-setup/attention");
  }

  getContext(applicationId: string): Promise<LoadingSetupContextResponseV1> {
    return this.getJson<LoadingSetupContextResponseV1>(`/api/v1/progression/guided-loading-setup/${encodeURIComponent(applicationId)}`);
  }

  save(applicationId: string, request: SaveLoadingSetupRequestV1): Promise<SaveLoadingSetupResultResponseV1> {
    return this.postJson<SaveLoadingSetupResultResponseV1>(`/api/v1/progression/guided-loading-setup/${encodeURIComponent(applicationId)}`, request);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await authorizedFetch(this.authTokenProvider, `${this.apiBaseUrl}${path}`);
    return this.parseResponse<T>(response);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await authorizedFetch(this.authTokenProvider, `${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `Guided loading setup API request failed: ${response.status}`;
      try {
        const parsed: unknown = await response.json();
        if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof (parsed as { message: unknown }).message === "string") {
          message = (parsed as { message: string }).message;
        }
      } catch {
        // The error envelope is always JSON in practice — the generic status-based message above is still a safe fallback.
      }
      throw new ProgressionApiRequestFailure(message, response.status);
    }
    return (await response.json()) as T;
  }
}
