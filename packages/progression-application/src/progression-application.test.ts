import { describe, expect, it } from "vitest";
import { isLegalSliceBTransition, type ProgressionApplicationStatus } from "./progression-application.js";

/**
 * Progression Application V1 — Slice B (task §35): pure, framework-neutral
 * unit tests for the transition vocabulary — no DB, no Nest, no mocks. The
 * derivation logic (stream identity, effective-from, expected load) and
 * the non-INCREASE/staleness/supersession *behavior* are inherently
 * DB-coupled and are instead proven by the real-Postgres integration
 * suite (task §34), matching this codebase's established practice of
 * never mocking the database for correctness-critical logic.
 */
describe("isLegalSliceBTransition (task §8's exhaustive Slice-B-legal transition table)", () => {
  const ALL_STATUSES: readonly ProgressionApplicationStatus[] = [
    "PENDING_REVIEW",
    "APPLIED",
    "KEPT_ORIGINAL",
    "STALE",
    "SUPERSEDED",
    "REVOKED",
  ];

  it("PROG-APP-B-001: PENDING_REVIEW -> KEPT_ORIGINAL is legal", () => {
    expect(isLegalSliceBTransition("PENDING_REVIEW", "KEPT_ORIGINAL")).toBe(true);
  });

  it("PROG-APP-B-002: PENDING_REVIEW -> STALE is legal", () => {
    expect(isLegalSliceBTransition("PENDING_REVIEW", "STALE")).toBe(true);
  });

  it("PROG-APP-B-003: PENDING_REVIEW -> SUPERSEDED is legal", () => {
    expect(isLegalSliceBTransition("PENDING_REVIEW", "SUPERSEDED")).toBe(true);
  });

  it("PROG-APP-B-004: PENDING_REVIEW -> APPLIED is NOT legal in Slice B (task §2's hard rule)", () => {
    expect(isLegalSliceBTransition("PENDING_REVIEW", "APPLIED")).toBe(false);
  });

  it("PROG-APP-B-005: PENDING_REVIEW -> REVOKED is NOT legal in Slice B", () => {
    expect(isLegalSliceBTransition("PENDING_REVIEW", "REVOKED")).toBe(false);
  });

  it("PROG-APP-B-006: every terminal state (KEPT_ORIGINAL/STALE/SUPERSEDED/APPLIED/REVOKED) has no legal outbound transition at all — terminal state immutability (task §24)", () => {
    const terminalStates: readonly ProgressionApplicationStatus[] = ["KEPT_ORIGINAL", "STALE", "SUPERSEDED", "APPLIED", "REVOKED"];
    for (const from of terminalStates) {
      for (const to of ALL_STATUSES) {
        expect(isLegalSliceBTransition(from, to)).toBe(false);
      }
    }
  });

  it("PROG-APP-B-007: no terminal state can return to PENDING_REVIEW", () => {
    for (const from of ALL_STATUSES) {
      if (from === "PENDING_REVIEW") continue;
      expect(isLegalSliceBTransition(from, "PENDING_REVIEW")).toBe(false);
    }
  });

  it("PROG-APP-B-008: exhaustively, exactly 3 transitions are legal in the full 6x6 matrix", () => {
    let legalCount = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (isLegalSliceBTransition(from, to)) legalCount++;
      }
    }
    expect(legalCount).toBe(3);
  });
});
