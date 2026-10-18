import type { MeResponse, UpdateTrainingTimeZoneRequestV1 } from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";

/** `GET /api/v1/me` + the one profile write mobile needs (Missed Workout V1 Slice D's training time zone bootstrap). */
export interface MeApiClient {
  getMe(): Promise<MeResponse>;
  setTrainingTimeZone(trainingTimeZone: string): Promise<MeResponse>;
}

export class MeApiRequestFailure extends Error {
  constructor(readonly status: number) {
    super(`Me API request failed: ${status}`);
  }
}

export class FetchMeApiClient implements MeApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  getMe(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/api/v1/me");
  }

  setTrainingTimeZone(trainingTimeZone: string): Promise<MeResponse> {
    const body: UpdateTrainingTimeZoneRequestV1 = { trainingTimeZone };
    return this.request<MeResponse>("PUT", "/api/v1/me/training-time-zone", body);
  }

  private async request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
    const accessToken = await this.authTokenProvider.getAccessToken();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new MeApiRequestFailure(response.status);
    return (await response.json()) as T;
  }
}
