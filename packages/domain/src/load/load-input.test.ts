import { describe, expect, it } from "vitest";
import { parseExactDecimalToMilli } from "./load-input.js";

describe("parseExactDecimalToMilli", () => {
  it("LOAD-INPUT-001: whole numbers", () => {
    expect(parseExactDecimalToMilli("2")).toBe(2000);
    expect(parseExactDecimalToMilli("100")).toBe(100000);
    expect(parseExactDecimalToMilli("0")).toBe(0);
  });

  it("LOAD-INPUT-002: one and two fractional digits, exactly — never floating-point ambiguity", () => {
    expect(parseExactDecimalToMilli("2.5")).toBe(2500);
    expect(parseExactDecimalToMilli("1.25")).toBe(1250);
    expect(parseExactDecimalToMilli("0.1")).toBe(100);
  });

  it("LOAD-INPUT-003: exactly 3 fractional digits (milli precision)", () => {
    expect(parseExactDecimalToMilli("1.001")).toBe(1001);
    expect(parseExactDecimalToMilli("2.125")).toBe(2125);
  });

  it("LOAD-INPUT-004: whitespace is trimmed", () => {
    expect(parseExactDecimalToMilli("  2.5  ")).toBe(2500);
  });

  it("LOAD-INPUT-005: excess precision (more than 3 fractional digits) is rejected, never truncated/rounded", () => {
    expect(parseExactDecimalToMilli("2.5555")).toBeNull();
    expect(parseExactDecimalToMilli("1.0001")).toBeNull();
  });

  it("LOAD-INPUT-006: malformed input is rejected", () => {
    expect(parseExactDecimalToMilli("")).toBeNull();
    expect(parseExactDecimalToMilli("abc")).toBeNull();
    expect(parseExactDecimalToMilli("-2.5")).toBeNull();
    expect(parseExactDecimalToMilli(".5")).toBeNull();
    expect(parseExactDecimalToMilli("2.")).toBeNull();
    expect(parseExactDecimalToMilli("2..5")).toBeNull();
    expect(parseExactDecimalToMilli("2 5")).toBeNull();
  });
});
