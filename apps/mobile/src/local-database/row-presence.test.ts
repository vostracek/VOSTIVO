import { describe, expect, it } from "vitest";
import { isRowPresent } from "./row-presence";

describe("isRowPresent", () => {
  it("treats null as absent — the actual value expo-sqlite's drizzle adapter returns for 'no row matched'", () => {
    expect(isRowPresent(null)).toBe(false);
  });

  it("treats undefined as absent", () => {
    expect(isRowPresent(undefined)).toBe(false);
  });

  it("treats a real row as present", () => {
    expect(isRowPresent({ id: "0000_bootstrap_health_check" })).toBe(true);
  });
});
