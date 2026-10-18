import { describe, expect, it } from "vitest";
import { formatContractVersion, isCompatible } from "./contract-version.js";

describe("contract versioning", () => {
  it("formats as major.minor", () => {
    expect(formatContractVersion({ major: 1, minor: 2 })).toBe("1.2");
  });

  it("is compatible only within the same major, at or below the supported minor", () => {
    const supported = { major: 1, minor: 2 };
    expect(isCompatible(supported, { major: 1, minor: 0 })).toBe(true);
    expect(isCompatible(supported, { major: 1, minor: 3 })).toBe(false);
    expect(isCompatible(supported, { major: 2, minor: 0 })).toBe(false);
  });
});
