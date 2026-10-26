import { describe, expect, it } from "vitest";
import { nextAuthRecoveryCount } from "./auth-recovery";

describe("nextAuthRecoveryCount", () => {
  it("AUTH-024: REAUTH_REQUIRED -> VALID (same owner re-verified) bumps the count, so Today reloads", () => {
    expect(nextAuthRecoveryCount("REAUTH_REQUIRED", "VALID", 0)).toBe(1);
    expect(nextAuthRecoveryCount("REAUTH_REQUIRED", "VALID", 3)).toBe(4);
  });

  it("losing the session, first READY and leaving READY never count", () => {
    expect(nextAuthRecoveryCount("VALID", "REAUTH_REQUIRED", 0)).toBe(0);
    expect(nextAuthRecoveryCount(null, "VALID", 0)).toBe(0);
    expect(nextAuthRecoveryCount("REAUTH_REQUIRED", null, 2)).toBe(2);
    expect(nextAuthRecoveryCount("VALID", "VALID", 2)).toBe(2);
  });
});
