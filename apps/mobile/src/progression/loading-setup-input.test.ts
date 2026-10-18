import { describe, expect, it } from "vitest";
import { parseEnumeratedListInput, parseFixedIncrementInput } from "./loading-setup-input";

describe("parseFixedIncrementInput", () => {
  it("SETUP-INPUT-001: valid decimal weight steps", () => {
    expect(parseFixedIncrementInput("2")).toBe(2000);
    expect(parseFixedIncrementInput("2.5")).toBe(2500);
    expect(parseFixedIncrementInput("1.25")).toBe(1250);
  });

  it("SETUP-INPUT-002: zero and malformed input are rejected", () => {
    expect(parseFixedIncrementInput("0")).toBeNull();
    expect(parseFixedIncrementInput("")).toBeNull();
    expect(parseFixedIncrementInput("abc")).toBeNull();
    expect(parseFixedIncrementInput("-2.5")).toBeNull();
  });
});

describe("parseEnumeratedListInput", () => {
  it("SETUP-INPUT-003: a valid ascending list, comma- or whitespace-separated", () => {
    expect(parseEnumeratedListInput("20, 22, 24, 26, 28")).toEqual({ ok: true, loadsMilli: [20000, 22000, 24000, 26000, 28000] });
    expect(parseEnumeratedListInput("20 22 24")).toEqual({ ok: true, loadsMilli: [20000, 22000, 24000] });
  });

  it("SETUP-INPUT-004: empty input is rejected, never defaulted", () => {
    expect(parseEnumeratedListInput("")).toEqual({ ok: false, reason: "EMPTY" });
    expect(parseEnumeratedListInput("   ")).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("SETUP-INPUT-005: a malformed entry is rejected outright — never silently skipped", () => {
    expect(parseEnumeratedListInput("20, abc, 30")).toEqual({ ok: false, reason: "MALFORMED_ENTRY" });
  });

  it("SETUP-INPUT-006: out-of-order or duplicate entries are rejected — never silently sorted or deduplicated", () => {
    expect(parseEnumeratedListInput("30, 20, 25")).toEqual({ ok: false, reason: "NOT_STRICTLY_ASCENDING" });
    expect(parseEnumeratedListInput("20, 20, 25")).toEqual({ ok: false, reason: "NOT_STRICTLY_ASCENDING" });
  });

  it("SETUP-INPUT-007: a zero/negative entry is rejected", () => {
    expect(parseEnumeratedListInput("0, 20, 25")).toEqual({ ok: false, reason: "NON_POSITIVE" });
  });

  it("SETUP-INPUT-008: never inserts a missing value — a genuinely incomplete list simply parses as the exact entries given", () => {
    // "20, 25, 30" with a real current load of 24 is a domain/resolver
    // concern (CURRENT_LOAD_UNSUPPORTED), never this parser's job to fix.
    expect(parseEnumeratedListInput("20, 25, 30")).toEqual({ ok: true, loadsMilli: [20000, 25000, 30000] });
  });
});
