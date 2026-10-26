import type { MissedWorkoutApplyRequestV1, MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";
import { authorizedFetch } from "../workout/authorized-request";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice D: the only place the
 * missed-workout HTTP calls happen. The preview sends an EMPTY body and the
 * apply sends ONLY `{ previewFingerprint }` — never workout ids, dates,
 * sequence, athlete id, time zone, slots or reason codes: the server
 * re-derives everything (Slice B/C).
 */
export interface MissedWorkoutApiClient {
  preview(): Promise<MissedWorkoutPreviewResponseV1>;
  apply(previewFingerprint: string): Promise<MissedWorkoutApplyResponseV1>;
}

/** A non-2xx answer: the HTTP status + the server's stable code (`message`) and optional `reasonCode` — never shown to the athlete. */
export class MissedWorkoutApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly reasonCode: string | null,
  ) {
    super(`Missed workout API request failed: ${status}${code === null ? "" : ` ${code}`}`);
  }
}

export class FetchMissedWorkoutApiClient implements MissedWorkoutApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  preview(): Promise<MissedWorkoutPreviewResponseV1> {
    return this.post<MissedWorkoutPreviewResponseV1>("/api/v1/plan/missed-workout-preview", {});
  }

  apply(previewFingerprint: string): Promise<MissedWorkoutApplyResponseV1> {
    const body: MissedWorkoutApplyRequestV1 = { previewFingerprint };
    return this.post<MissedWorkoutApplyResponseV1>("/api/v1/plan/missed-workout-apply", body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await authorizedFetch(this.authTokenProvider, `${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toFailure(response);
    return (await response.json()) as T;
  }
}

async function toFailure(response: Response): Promise<MissedWorkoutApiFailure> {
  try {
    const body = (await response.json()) as { readonly message?: unknown; readonly reasonCode?: unknown };
    return new MissedWorkoutApiFailure(
      response.status,
      typeof body.message === "string" ? body.message : null,
      typeof body.reasonCode === "string" ? body.reasonCode : null,
    );
  } catch {
    return new MissedWorkoutApiFailure(response.status, null, null);
  }
}
