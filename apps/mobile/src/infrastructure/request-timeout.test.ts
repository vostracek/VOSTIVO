import { describe, expect, it } from "vitest";
import { createBoundedFetch, RequestTimeoutError, withRequestTimeout } from "./request-timeout";

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("withRequestTimeout", () => {
  it("resolves with the request's value before the deadline", async () => {
    expect(await withRequestTimeout(1_000, () => Promise.resolve("ok"))).toBe("ok");
  });

  it("passes the request's own rejection through unchanged", async () => {
    const failure = new TypeError("Network request failed");
    await expect(withRequestTimeout(1_000, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it("rejects with RequestTimeoutError at the deadline even if the request ignores its signal, and aborts the signal", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withRequestTimeout(20, (given) => {
        signal = given;
        return never();
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("a late result or rejection of an abandoned request is swallowed (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let lateReject: (error: unknown) => void = () => {};
      await expect(withRequestTimeout(10, () => new Promise((_resolve, reject) => (lateReject = reject)))).rejects.toBeInstanceOf(RequestTimeoutError);
      lateReject(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears its timer once the request settles (a fast answer never aborts afterwards)", async () => {
    let signal: AbortSignal | undefined;
    await withRequestTimeout(20, (given) => {
      signal = given;
      return Promise.resolve(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal?.aborted).toBe(false);
  });
});

describe("createBoundedFetch", () => {
  it("a hanging request rejects with RequestTimeoutError and the underlying fetch sees an aborted signal", async () => {
    let signal: AbortSignal | null | undefined;
    const bounded = createBoundedFetch(20, (_input, init) => {
      signal = init?.signal;
      return never();
    });
    await expect(bounded("https://auth.invalid/token")).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("passes the request through unchanged and returns the response", async () => {
    const response = new Response("{}", { status: 200 });
    let seenInit: RequestInit | undefined;
    const bounded = createBoundedFetch(1_000, (_input, init) => {
      seenInit = init;
      return Promise.resolve(response);
    });
    expect(await bounded("https://auth.invalid/token", { method: "POST", headers: { apikey: "k" } })).toBe(response);
    expect(seenInit).toMatchObject({ method: "POST", headers: { apikey: "k" } });
  });

  it("the caller's own signal still aborts the request", async () => {
    let signal: AbortSignal | null | undefined;
    const bounded = createBoundedFetch(1_000, (_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    const caller = new AbortController();
    const request = bounded("https://auth.invalid/token", { signal: caller.signal });
    caller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
  });
});
