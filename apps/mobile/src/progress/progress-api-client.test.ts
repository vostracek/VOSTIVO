import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchProgressApiClient, ProgressApiFailure, isProgressNotFound } from "./progress-api-client";

const CURSOR = "eyJ0IjoiMjAyNi0xMC0xMyAwOTowMDowMC4wMDA5KzAwIiwiaSI6IngifQ==";

function client() {
  const calls: { url: string; headers: unknown }[] = [];
  const fetchMock = vi.fn((url: string, init?: { headers?: unknown }) => {
    calls.push({ url, headers: init?.headers });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: url.includes("missing") ? 404 : 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { api: new FetchProgressApiClient("https://api.test", { getAccessToken: () => Promise.resolve("token") }), calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchProgressApiClient", () => {
  it("calls the four Slice A reads with a bearer token and never an athlete id", async () => {
    const { api, calls } = client();
    await api.getOverview();
    await api.getWorkoutHistory(null);
    await api.getWorkoutDetail("0199a1b2-0000-7000-8000-000000000001");
    await api.getExerciseHistory("dumbbell-bench-press", null);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/progress",
      "https://api.test/api/v1/progress/workouts?limit=20",
      "https://api.test/api/v1/progress/workouts/0199a1b2-0000-7000-8000-000000000001",
      "https://api.test/api/v1/progress/exercises/dumbbell-bench-press?limit=20",
    ]);
    expect(calls.every((c) => JSON.stringify(c.headers) === JSON.stringify({ authorization: "Bearer token" }))).toBe(true);
    expect(calls.some((c) => /athlete/i.test(c.url))).toBe(false);
  });

  it("passes the server cursor back unchanged (URL-encoded only for transport)", async () => {
    const { api, calls } = client();
    await api.getWorkoutHistory(CURSOR);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("before")).toBe(CURSOR);
  });

  it("a 404 is a ProgressApiFailure recognised as not-found", async () => {
    const { api } = client();
    const error = await api.getWorkoutDetail("missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProgressApiFailure);
    expect(isProgressNotFound(error)).toBe(true);
    expect(isProgressNotFound(new ProgressApiFailure(500))).toBe(false);
  });
});
