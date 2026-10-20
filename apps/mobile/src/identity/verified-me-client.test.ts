import { describe, expect, it } from "vitest";
import { fetchVerifiedMe, type FetchFunction } from "./verified-me-client";

function respond(status: number, body: unknown): FetchFunction {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("fetchVerifiedMe — typed by why it failed", () => {
  it("2xx with userId + athleteProfileId -> VERIFIED; the token goes only into the Authorization header", async () => {
    let seen: { url: string; authorization: string | undefined } | undefined;
    const fetchFunction: FetchFunction = (url, init) => {
      seen = { url, authorization: init.headers.authorization };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ userId: "u", athleteProfileId: "p", status: "ACTIVE" }) });
    };
    expect(await fetchVerifiedMe("http://api", "tok", fetchFunction)).toEqual({ kind: "VERIFIED", userId: "u", athleteProfileId: "p" });
    expect(seen).toEqual({ url: "http://api/api/v1/me", authorization: "Bearer tok" });
  });

  it("network failure and 5xx -> UNREACHABLE; 401/403 -> UNAUTHORIZED; other -> INVALID_RESPONSE", async () => {
    expect(await fetchVerifiedMe("http://api", "tok", () => Promise.reject(new TypeError("Network request failed")))).toEqual({ kind: "UNREACHABLE" });
    expect(await fetchVerifiedMe("http://api", "tok", respond(503, {}))).toEqual({ kind: "UNREACHABLE" });
    expect(await fetchVerifiedMe("http://api", "tok", respond(401, {}))).toEqual({ kind: "UNAUTHORIZED" });
    expect(await fetchVerifiedMe("http://api", "tok", respond(403, {}))).toEqual({ kind: "UNAUTHORIZED" });
    expect(await fetchVerifiedMe("http://api", "tok", respond(404, {}))).toEqual({ kind: "INVALID_RESPONSE" });
    expect(await fetchVerifiedMe("http://api", "tok", respond(200, { userId: "" }))).toEqual({ kind: "INVALID_RESPONSE" });
  });
});
