import { describe, expect, it } from "vitest";
import { EXPERIENCE_MODES } from "./athlete-profile.js";
import { isUsableAccountStatus, USER_STATUSES } from "./user.js";

describe("identity domain vocabulary", () => {
  it("does not persist COACHED as a base experience mode", () => {
    expect(EXPERIENCE_MODES).toEqual(["GUIDED", "ADAPTIVE", "EXPERT"]);
    expect(EXPERIENCE_MODES).not.toContain("COACHED");
  });

  it("only treats ACTIVE as a usable account status", () => {
    for (const status of USER_STATUSES) {
      expect(isUsableAccountStatus(status)).toBe(status === "ACTIVE");
    }
  });
});
