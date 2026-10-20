import type { MeResponse } from "@vostivo/contracts";

/**
 * `GET /api/v1/me` for identity verification. Unlike the profile client, the
 * outcome is typed by WHY it failed, because the gate treats "could not
 * reach the server" (offline: a verified binding may be used) completely
 * differently from "the server refused this token" (fail closed).
 */
export type VerifiedMeOutcome =
  | { readonly kind: "VERIFIED"; readonly userId: string; readonly athleteProfileId: string }
  /** No answer from the API (offline, DNS, timeout) or a 5xx — the server could not judge the token. */
  | { readonly kind: "UNREACHABLE" }
  /** 401/403 — the server refused this token. */
  | { readonly kind: "UNAUTHORIZED" }
  /** Any other answer (other 4xx, malformed body). */
  | { readonly kind: "INVALID_RESPONSE" };

export type FetchFunction = (input: string, init: { method: string; headers: Record<string, string> }) => Promise<Pick<Response, "ok" | "status" | "json">>;

export async function fetchVerifiedMe(apiBaseUrl: string, accessToken: string, fetchFunction: FetchFunction = fetch): Promise<VerifiedMeOutcome> {
  let response: Pick<Response, "ok" | "status" | "json">;
  try {
    response = await fetchFunction(`${apiBaseUrl}/api/v1/me`, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    return { kind: "UNREACHABLE" };
  }
  if (response.status >= 500) return { kind: "UNREACHABLE" };
  if (response.status === 401 || response.status === 403) return { kind: "UNAUTHORIZED" };
  if (!response.ok) return { kind: "INVALID_RESPONSE" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "INVALID_RESPONSE" };
  }
  const me = body as Partial<MeResponse> | null;
  if (me === null || typeof me.userId !== "string" || me.userId.length === 0 || typeof me.athleteProfileId !== "string" || me.athleteProfileId.length === 0) {
    return { kind: "INVALID_RESPONSE" };
  }
  return { kind: "VERIFIED", userId: me.userId, athleteProfileId: me.athleteProfileId };
}
