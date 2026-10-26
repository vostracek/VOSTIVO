import type { AuthTokenProvider } from "./auth-token-provider";

/**
 * Auth Slice C — the one 401 policy every authenticated request follows:
 *
 *   send(token) -> 401 -> provider.recoverFromUnauthorized(token)
 *     (single-flight refresh inside the session source) -> REFRESHED ->
 *   send(newToken) ONCE -> still 401 -> provider.reportSessionInvalid()
 *
 * Never a loop: at most two sends per call. A network failure while
 * refreshing propagates as `AuthServiceUnavailableError` (offline, not an
 * invalid session). Returns the final result; `unauthorized` tells the
 * caller the session could not be made acceptable.
 */
export async function sendWithAuthRecovery<T>(
  provider: AuthTokenProvider,
  send: (accessToken: string) => Promise<T>,
  isUnauthorized: (result: T) => boolean,
): Promise<{ readonly result: T; readonly unauthorized: boolean }> {
  const firstToken = await provider.getAccessToken();
  const first = await send(firstToken);
  if (!isUnauthorized(first)) return { result: first, unauthorized: false };

  if (provider.recoverFromUnauthorized === undefined) return { result: first, unauthorized: true };
  const recovery = await provider.recoverFromUnauthorized(firstToken);
  if (recovery === "SESSION_INVALID") return { result: first, unauthorized: true };

  const retried = await send(await provider.getAccessToken());
  if (!isUnauthorized(retried)) return { result: retried, unauthorized: false };
  await provider.reportSessionInvalid?.();
  return { result: retried, unauthorized: true };
}

/**
 * `fetch` with the owner's bearer token and the 401 policy above. A final
 * 401 is returned as-is so each API client keeps its own typed failure.
 */
export async function authorizedFetch(provider: AuthTokenProvider, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const { result } = await sendWithAuthRecovery(
    provider,
    (accessToken) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}` } }),
    (response) => response.status === 401,
  );
  return result;
}
