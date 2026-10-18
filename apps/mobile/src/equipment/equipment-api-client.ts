import type {
  EquipmentAdaptationApplyRequestV1,
  EquipmentAdaptationApplyResponseV1,
  EquipmentAdaptationOptionsResponseV1,
  EquipmentAdaptationPreviewRequestV1,
  EquipmentAdaptationPreviewResponseV1,
} from "@vostivo/contracts";
import type { AuthTokenProvider } from "../workout/auth-token-provider";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice D: the only place the
 * equipment HTTP calls happen. The preview sends ONLY `{ plannedWorkoutId,
 * catalogVersion, availableEquipmentIds }` and the apply ONLY those plus
 * `previewFingerprint` — never replacements, candidates, names, loads,
 * dates or athlete ids: the server re-derives everything (Slice B/C).
 */
export interface EquipmentApiClient {
  options(plannedWorkoutId: string): Promise<EquipmentAdaptationOptionsResponseV1>;
  preview(request: EquipmentAdaptationPreviewRequestV1): Promise<EquipmentAdaptationPreviewResponseV1>;
  apply(request: EquipmentAdaptationApplyRequestV1): Promise<EquipmentAdaptationApplyResponseV1>;
}

/** A non-2xx answer: the HTTP status + the server's stable code (`message`) and optional `reasonCode` — never shown to the athlete. */
export class EquipmentApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly reasonCode: string | null,
  ) {
    super(`Equipment API request failed: ${status}${code === null ? "" : ` ${code}`}`);
  }
}

export class FetchEquipmentApiClient implements EquipmentApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authTokenProvider: AuthTokenProvider,
  ) {}

  options(plannedWorkoutId: string): Promise<EquipmentAdaptationOptionsResponseV1> {
    return this.request<EquipmentAdaptationOptionsResponseV1>("GET", `/api/v1/plan/equipment-adaptation-options?plannedWorkoutId=${encodeURIComponent(plannedWorkoutId)}`, undefined);
  }

  preview(request: EquipmentAdaptationPreviewRequestV1): Promise<EquipmentAdaptationPreviewResponseV1> {
    // Rebuilt field by field: nothing but the three contract fields ever leaves the device.
    const body: EquipmentAdaptationPreviewRequestV1 = { plannedWorkoutId: request.plannedWorkoutId, catalogVersion: request.catalogVersion, availableEquipmentIds: [...request.availableEquipmentIds] };
    return this.request<EquipmentAdaptationPreviewResponseV1>("POST", "/api/v1/plan/equipment-adaptation-preview", body);
  }

  apply(request: EquipmentAdaptationApplyRequestV1): Promise<EquipmentAdaptationApplyResponseV1> {
    const body: EquipmentAdaptationApplyRequestV1 = {
      plannedWorkoutId: request.plannedWorkoutId,
      previewFingerprint: request.previewFingerprint,
      catalogVersion: request.catalogVersion,
      availableEquipmentIds: [...request.availableEquipmentIds],
    };
    return this.request<EquipmentAdaptationApplyResponseV1>("POST", "/api/v1/plan/equipment-adaptation-apply", body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body: unknown): Promise<T> {
    const accessToken = await this.authTokenProvider.getAccessToken();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${accessToken}` } : { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await toFailure(response);
    return (await response.json()) as T;
  }
}

async function toFailure(response: Response): Promise<EquipmentApiFailure> {
  try {
    const body = (await response.json()) as { readonly message?: unknown; readonly reasonCode?: unknown };
    return new EquipmentApiFailure(response.status, typeof body.message === "string" ? body.message : null, typeof body.reasonCode === "string" ? body.reasonCode : null);
  } catch {
    return new EquipmentApiFailure(response.status, null, null);
  }
}
