import { describe, expect, it } from "vitest";
import { computeElapsedSeconds, formatElapsedDuration } from "./elapsed-time";

describe("elapsed workout time — derived, not persisted", () => {
  it("computes elapsed seconds purely from startedAt and now", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z").toISOString();
    const now = new Date("2026-09-05T10:05:30.000Z");

    expect(computeElapsedSeconds(startedAt, now)).toBe(330);
  });

  it("survives a simulated backgrounding gap — the same computation regardless of how much wall-clock time passed silently", () => {
    const startedAt = new Date("2026-09-05T10:00:00.000Z").toISOString();
    const muchLater = new Date("2026-09-05T11:30:00.000Z");

    expect(computeElapsedSeconds(startedAt, muchLater)).toBe(90 * 60);
  });

  it("formats under an hour as MM:SS", () => {
    expect(formatElapsedDuration(330)).toBe("05:30");
    expect(formatElapsedDuration(5)).toBe("00:05");
  });

  it("formats an hour or more as H:MM:SS", () => {
    expect(formatElapsedDuration(3661)).toBe("1:01:01");
  });
});
