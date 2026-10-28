import type { MeResponse } from "@vostivo/contracts";
import { RequestTimeoutError, withRequestTimeout } from "../infrastructure/request-timeout";

/**
 * `GET /api/v1/me` for identity verification. Unlike the profile client, the
 * outcome is typed by WHY it failed, because the gate treats "could not
 * reach the server" (offline: a verified binding may be used) completely
 * differently from "the server refused this token" (fail closed).
 */
export type VerifiedMeOutcome =
  | { readonly kind: "VERIFIED"; readonly userId: string; readonly athleteProfileId: string }
  /** No answer from the API (offline, DNS, no answer within `VERIFIED_ME_TIMEOUT_MS`) or a 5xx — the server could not judge the token. */
  | { readonly kind: "UNREACHABLE" }
  /** 401/403 — the server refused this token. */
  | { readonly kind: "UNAUTHORIZED" }
  /** Any other answer (other 4xx, malformed body). */
  | { readonly kind: "INVALID_RESPONSE" };

export type FetchFunction = (input: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** How long the IdentityGate waits for `/me` (request + body) before treating the API as unreachable. */
export const VERIFIED_ME_TIMEOUT_MS = 5_000;

type MeAnswer = { readonly kind: "UNREACHABLE" } | { readonly kind: "RESPONSE"; readonly status: number; readonly ok: boolean; readonly body: unknown; readonly bodyReadable: boolean };

export async function fetchVerifiedMe(apiBaseUrl: string, accessToken: string, fetchFunction: FetchFunction = fetch, timeoutMs = VERIFIED_ME_TIMEOUT_MS): Promise<VerifiedMeOutcome> {
  let answer: MeAnswer;
  try {
    // One deadline for the request AND its body: a server that accepts the connection and then stalls is unreachable, not "still thinking".
    answer = await withRequestTimeout(timeoutMs, async (signal) => {
      let response: Pick<Response, "ok" | "status" | "json">;
      try {
        response = await fetchFunction(`${apiBaseUrl}/api/v1/me`, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, signal });
      } catch {
        return { kind: "UNREACHABLE" };
      }
      if (!response.ok) return { kind: "RESPONSE", status: response.status, ok: false, body: undefined, bodyReadable: false };
      try {
        return { kind: "RESPONSE", status: response.status, ok: true, body: (await response.json()) as unknown, bodyReadable: true };
      } catch {
        return { kind: "RESPONSE", status: response.status, ok: true, body: undefined, bodyReadable: false };
      }
    });
  } catch (error) {
    if (error instanceof RequestTimeoutError) return { kind: "UNREACHABLE" };
    throw error;
  }
  if (answer.kind === "UNREACHABLE") return answer;
  if (answer.status >= 500) return { kind: "UNREACHABLE" };
  if (answer.status === 401 || answer.status === 403) return { kind: "UNAUTHORIZED" };
  if (!answer.ok || !answer.bodyReadable) return { kind: "INVALID_RESPONSE" };

  const me = answer.body as Partial<MeResponse> | null;
  if (me === null || typeof me.userId !== "string" || me.userId.length === 0 || typeof me.athleteProfileId !== "string" || me.athleteProfileId.length === 0) {
    return { kind: "INVALID_RESPONSE" };
  }
  return { kind: "VERIFIED", userId: me.userId, athleteProfileId: me.athleteProfileId };
}
