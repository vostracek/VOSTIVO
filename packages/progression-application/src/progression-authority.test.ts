import { describe, expect, it } from "vitest";
import { resolveProgressionAuthority } from "./progression-authority.js";

/**
 * Progression Application V1 — Slice D (task §62): pure, deterministic,
 * no DB, no COACHED case, no billing case.
 */
describe("resolveProgressionAuthority", () => {
  it("PROG-APP-D-AUTH-001: GUIDED -> SYSTEM_AUTO_APPLY", () => {
    expect(resolveProgressionAuthority({ experienceMode: "GUIDED" })).toBe("SYSTEM_AUTO_APPLY");
  });

  it("PROG-APP-D-AUTH-002: ADAPTIVE -> ATHLETE_REVIEW", () => {
    expect(resolveProgressionAuthority({ experienceMode: "ADAPTIVE" })).toBe("ATHLETE_REVIEW");
  });

  it("PROG-APP-D-AUTH-003: EXPERT -> ATHLETE_REVIEW (identical to ADAPTIVE in V1)", () => {
    expect(resolveProgressionAuthority({ experienceMode: "EXPERT" })).toBe("ATHLETE_REVIEW");
  });

  it("PROG-APP-D-AUTH-004: is a pure function of experienceMode alone — same input always yields the same output", () => {
    const results = new Set(Array.from({ length: 5 }, () => resolveProgressionAuthority({ experienceMode: "GUIDED" })));
    expect(results.size).toBe(1);
  });
});
