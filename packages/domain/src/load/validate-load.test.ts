import { describe, expect, it } from "vitest";
import { validateEnumeratedListLoads } from "./validate-load.js";

describe("validateEnumeratedListLoads (Loading Capability V1)", () => {
  it("accepts a valid strictly ascending, unique, positive integer list", () => {
    const result = validateEnumeratedListLoads([20000, 22000, 24000, 26000]);
    expect(result).toEqual({ ok: true, value: [20000, 22000, 24000, 26000] });
  });

  it("accepts a single-entry list", () => {
    const result = validateEnumeratedListLoads([20000]);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty list", () => {
    const result = validateEnumeratedListLoads([]);
    expect(result).toEqual({ ok: false, error: { reason: "EMPTY" } });
  });

  it("rejects a non-integer value", () => {
    const result = validateEnumeratedListLoads([20000, 22500.5, 24000]);
    expect(result).toEqual({ ok: false, error: { reason: "NON_INTEGER" } });
  });

  it("rejects a zero value", () => {
    const result = validateEnumeratedListLoads([0, 20000]);
    expect(result).toEqual({ ok: false, error: { reason: "NON_POSITIVE" } });
  });

  it("rejects a negative value", () => {
    const result = validateEnumeratedListLoads([-20000, 20000]);
    expect(result).toEqual({ ok: false, error: { reason: "NON_POSITIVE" } });
  });

  it("rejects a duplicate value", () => {
    const result = validateEnumeratedListLoads([20000, 20000, 24000]);
    expect(result).toEqual({ ok: false, error: { reason: "NOT_STRICTLY_ASCENDING" } });
  });

  it("rejects an unsorted list — never silently sorted", () => {
    const result = validateEnumeratedListLoads([24000, 20000, 22000]);
    expect(result).toEqual({ ok: false, error: { reason: "NOT_STRICTLY_ASCENDING" } });
  });

  it("rejects a descending pair", () => {
    const result = validateEnumeratedListLoads([26000, 24000]);
    expect(result).toEqual({ ok: false, error: { reason: "NOT_STRICTLY_ASCENDING" } });
  });
});
