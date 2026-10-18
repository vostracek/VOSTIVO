import { describe, expect, it } from "vitest";
import { loadToAmountMilli, parseLoadInput, parseRepsInput } from "./numeric-input";

describe("parseRepsInput", () => {
  it("accepts a plain integer", () => {
    expect(parseRepsInput("8")).toBe(8);
  });

  it("treats an empty string as a valid intermediate state, not an error", () => {
    expect(parseRepsInput("")).toBeNull();
  });

  it("treats a cleared-then-empty value the same as never-typed", () => {
    // Simulates: field held "8", athlete selects-all and deletes it.
    const cleared = "";
    expect(parseRepsInput(cleared)).toBeNull();
  });

  it("lets a cleared value be fully replaced by a new one", () => {
    // Simulates: "8" -> clear -> "12".
    expect(parseRepsInput("")).toBeNull();
    expect(parseRepsInput("12")).toBe(12);
  });

  it("rejects a decimal outright rather than silently truncating it", () => {
    expect(parseRepsInput("8.5")).toBeNull();
  });

  it("rejects zero and negative values", () => {
    expect(parseRepsInput("0")).toBeNull();
    expect(parseRepsInput("-3")).toBeNull();
  });

  it("rejects non-numeric text", () => {
    expect(parseRepsInput("abc")).toBeNull();
  });
});

describe("parseLoadInput", () => {
  it("accepts a plain integer", () => {
    expect(parseLoadInput("60")).toBe(60);
  });

  it("accepts decimal entry", () => {
    expect(parseLoadInput("42.5")).toBe(42.5);
  });

  it("treats an empty string as a valid intermediate state, not an error", () => {
    expect(parseLoadInput("")).toBeNull();
  });

  it("lets a cleared value be fully replaced by a new decimal value", () => {
    // Simulates: "60" -> clear -> "42.5" (the exact athlete flow from the bug report).
    expect(parseLoadInput("")).toBeNull();
    expect(parseLoadInput("42.5")).toBe(42.5);
  });

  it("accepts zero as a valid load", () => {
    expect(parseLoadInput("0")).toBe(0);
  });

  it("rejects negative values", () => {
    expect(parseLoadInput("-5")).toBeNull();
  });

  it("rejects non-numeric text", () => {
    expect(parseLoadInput("abc")).toBeNull();
  });
});

describe("loadToAmountMilli", () => {
  it("converts a validated load to the fixed-precision milli integer only at the boundary", () => {
    expect(loadToAmountMilli(42.5)).toBe(42500);
    expect(loadToAmountMilli(60)).toBe(60000);
  });

  it("never receives fractional-cent drift from repeated re-parsing", () => {
    // Guards the "immediate string -> number coercion" failure mode:
    // converting back and forth must be idempotent for valid input.
    const load = parseLoadInput("42.5");
    expect(load).not.toBeNull();
    expect(loadToAmountMilli(load ?? 0)).toBe(42500);
  });
});
