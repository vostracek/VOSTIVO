import { describe, expect, it } from "vitest";
import { isSetType, SET_TYPES } from "./set-type.js";

describe("SetType — Progression Prerequisites V1 (PROG-PREREQ)", () => {
  it("accepts exactly WORKING and WARM_UP", () => {
    expect(SET_TYPES).toEqual(["WORKING", "WARM_UP"]);
    expect(isSetType("WORKING")).toBe(true);
    expect(isSetType("WARM_UP")).toBe(true);
  });

  it("rejects missing/null/undefined", () => {
    expect(isSetType(null)).toBe(false);
    expect(isSetType(undefined)).toBe(false);
  });

  it("rejects an arbitrary string", () => {
    expect(isSetType("SOMETHING")).toBe(false);
  });

  it("rejects a future reserved value not yet part of the V1 vocabulary", () => {
    expect(isSetType("BACKOFF")).toBe(false);
    expect(isSetType("DROP")).toBe(false);
    expect(isSetType("AMRAP")).toBe(false);
    expect(isSetType("FAILURE")).toBe(false);
  });

  it("rejects the wrong case — this is not a fuzzy/case-insensitive match", () => {
    expect(isSetType("working")).toBe(false);
    expect(isSetType("Warm_Up")).toBe(false);
    expect(isSetType("WARMUP")).toBe(false); // the pre-resolution draft spelling — never valid
  });

  it("rejects a non-string value", () => {
    expect(isSetType(1)).toBe(false);
    expect(isSetType({})).toBe(false);
    expect(isSetType([])).toBe(false);
  });
});
