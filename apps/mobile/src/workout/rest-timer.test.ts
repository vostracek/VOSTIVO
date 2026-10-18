import { describe, expect, it } from "vitest";
import { DEFAULT_REST_SECONDS, computeRemainingSeconds, isRestTimerFinished, resolveRestDuration } from "./rest-timer";

describe("resolveRestDuration", () => {
  it("uses the prescribed restSeconds when present", () => {
    expect(resolveRestDuration({ restSeconds: 120 })).toBe(120);
  });

  it("falls back to the centralized default when restSeconds is null", () => {
    expect(resolveRestDuration({ restSeconds: null })).toBe(DEFAULT_REST_SECONDS);
  });

  it("falls back to the centralized default when no prescribed set is given", () => {
    expect(resolveRestDuration(undefined)).toBe(DEFAULT_REST_SECONDS);
  });
});

describe("AW-MOB-006: rest timer remaining time is derived from persisted timestamps, never a ticking counter", () => {
  it("computes remaining time purely from startedAt/durationSeconds", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z");
    const state = { startedAt: startedAt.toISOString(), durationSeconds: 90 };

    // 30 seconds later — including a simulated backgrounding/re-render in
    // between, which this pure function is structurally immune to since
    // it never reads a decrementing in-memory value.
    const thirtySecondsLater = new Date(startedAt.getTime() + 30_000);
    expect(computeRemainingSeconds(state, thirtySecondsLater)).toBe(60);
  });

  it("reconstructs correctly even after a long gap (simulating a force-stop/relaunch)", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z");
    const state = { startedAt: startedAt.toISOString(), durationSeconds: 90 };

    const muchLater = new Date(startedAt.getTime() + 10 * 60_000); // 10 minutes later
    expect(computeRemainingSeconds(state, muchLater)).toBe(0);
    expect(isRestTimerFinished(state, muchLater)).toBe(true);
  });

  it("never returns a negative remaining time", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z");
    const state = { startedAt: startedAt.toISOString(), durationSeconds: 15 };

    const wayLater = new Date(startedAt.getTime() + 60_000);
    expect(computeRemainingSeconds(state, wayLater)).toBe(0);
  });

  it("is not finished while time remains", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z");
    const state = { startedAt: startedAt.toISOString(), durationSeconds: 90 };

    expect(isRestTimerFinished(state, new Date(startedAt.getTime() + 10_000))).toBe(false);
  });
});
