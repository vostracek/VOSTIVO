/**
 * Bounded network requests. React Native's Android HTTP stack has no
 * connect/read timeout at all (OkHttp configured with 0 = infinite), so a
 * backend that accepts the connection and never answers would otherwise
 * hold a request — and anything awaiting it, like the IdentityGate's boot —
 * forever.
 */

/** The request did not finish before its deadline; callers map it to "could not reach the server". */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request did not finish within ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * Runs `request` with an AbortSignal that fires after `timeoutMs` and
 * settles at the deadline even if the request ignores the signal. The
 * timer is always cleared, and a late result or rejection of the abandoned
 * request is swallowed (never an unhandled rejection).
 */
export function withRequestTimeout<T>(timeoutMs: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);
    request(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A `fetch` whose every request is bounded by `timeoutMs`. A caller's own
 * `signal` still aborts the request. The deadline covers the response
 * headers; the body is read by the caller.
 */
export function createBoundedFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  return (input, init) =>
    withRequestTimeout(timeoutMs, (signal) => {
      const callerSignal = init?.signal;
      if (callerSignal != null) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (callerSignal.aborted) abort();
        callerSignal.addEventListener("abort", abort, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        return baseFetch(input, { ...init, signal: controller.signal }).finally(() => callerSignal.removeEventListener("abort", abort));
      }
      return baseFetch(input, { ...init, signal });
    });
}
