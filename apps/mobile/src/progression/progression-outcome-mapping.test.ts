import { describe, expect, it } from "vitest";
import { mapCommandResponseToUiOutcome, mapHttpErrorToUiOutcome } from "./progression-outcome-mapping";

describe("mapCommandResponseToUiOutcome", () => {
  it("PROG-MOB-001: APPLIED -> applied", () => {
    expect(mapCommandResponseToUiOutcome({ status: "APPLIED" })).toEqual({ kind: "applied" });
  });

  it("PROG-MOB-002: KEPT_ORIGINAL -> kept-original", () => {
    expect(mapCommandResponseToUiOutcome({ status: "KEPT_ORIGINAL" })).toEqual({ kind: "kept-original" });
  });

  it("PROG-MOB-003: NOT_APPLIED with reason PROPOSAL_REFRESH_REQUIRED -> refresh-required, never auto-applied", () => {
    expect(mapCommandResponseToUiOutcome({ status: "NOT_APPLIED", reason: "PROPOSAL_REFRESH_REQUIRED" })).toEqual({ kind: "refresh-required" });
  });

  it.each(["STALE", "SUPERSEDED", "LOADING_CAPABILITY_UNAVAILABLE", "LOADING_CAPABILITY_INVALID", "CAPABILITY_INCOMPATIBLE", "CURRENT_LOAD_UNSUPPORTED", "NO_SUITABLE_INCREMENT", "NO_CURRENT_LOAD"])(
    "PROG-MOB-004: NOT_APPLIED with reason %s -> the single generic unavailable state, never a raw machine code",
    (reason) => {
      expect(mapCommandResponseToUiOutcome({ status: "NOT_APPLIED", reason })).toEqual({ kind: "unavailable" });
    },
  );
});

describe("mapHttpErrorToUiOutcome", () => {
  it("PROG-MOB-005: 404 -> not-found regardless of message", () => {
    expect(mapHttpErrorToUiOutcome(404, "Progression application not found")).toEqual({ kind: "not-found" });
  });

  it("PROG-MOB-006: 409 with MODE_ACTION_NOT_ALLOWED -> mode-changed", () => {
    expect(mapHttpErrorToUiOutcome(409, "MODE_ACTION_NOT_ALLOWED")).toEqual({ kind: "mode-changed" });
  });

  it("PROG-MOB-007: 409 with COMMAND_CONFLICT -> transient (never confused with a real mode change)", () => {
    expect(mapHttpErrorToUiOutcome(409, "COMMAND_CONFLICT")).toEqual({ kind: "transient", message: "COMMAND_CONFLICT" });
  });

  it("PROG-MOB-008: 500 -> transient, carrying the message for a Retry-able error", () => {
    expect(mapHttpErrorToUiOutcome(500, "An unexpected error occurred")).toEqual({ kind: "transient", message: "An unexpected error occurred" });
  });
});
