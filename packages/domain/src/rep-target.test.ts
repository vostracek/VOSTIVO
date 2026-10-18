import { describe, expect, it } from "vitest";
import { repTargetFromRange, repTargetToRange } from "./rep-target.js";

describe("REP-001: exact target round-trips as EXACT", () => {
  it("equal min/max bounds collapse to an EXACT target", () => {
    const result = repTargetFromRange({ minReps: 10, maxReps: 10 });

    expect(result).toEqual({ ok: true, value: { kind: "EXACT", reps: 10 } });
  });

  it("round-trips back to the same equal bounds", () => {
    expect(repTargetToRange({ kind: "EXACT", reps: 10 })).toEqual({ minReps: 10, maxReps: 10 });
  });

  it("no target at all round-trips as null", () => {
    const result = repTargetFromRange({ minReps: null, maxReps: null });
    expect(result).toEqual({ ok: true, value: null });
    expect(repTargetToRange(null)).toEqual({ minReps: null, maxReps: null });
  });
});

describe("REP-002: range 8-12 round-trips as RANGE 8-12", () => {
  it("distinct min/max bounds become a RANGE target", () => {
    const result = repTargetFromRange({ minReps: 8, maxReps: 12 });

    expect(result).toEqual({ ok: true, value: { kind: "RANGE", minReps: 8, maxReps: 12 } });
  });

  it("round-trips back to the same bounds", () => {
    expect(repTargetToRange({ kind: "RANGE", minReps: 8, maxReps: 12 })).toEqual({ minReps: 8, maxReps: 12 });
  });
});

describe("REP-006: invalid ranges are rejected", () => {
  it("rejects a zero bound", () => {
    const result = repTargetFromRange({ minReps: 0, maxReps: 10 });
    expect(result).toEqual({ ok: false, error: { reason: "NON_POSITIVE_REPS" } });
  });

  it("rejects a negative bound", () => {
    const result = repTargetFromRange({ minReps: -1, maxReps: 10 });
    expect(result).toEqual({ ok: false, error: { reason: "NON_POSITIVE_REPS" } });
  });

  it("rejects min greater than max", () => {
    const result = repTargetFromRange({ minReps: 12, maxReps: 8 });
    expect(result).toEqual({ ok: false, error: { reason: "MIN_GREATER_THAN_MAX" } });
  });

  it("rejects non-integer reps", () => {
    const result = repTargetFromRange({ minReps: 8.5, maxReps: 12 });
    expect(result).toEqual({ ok: false, error: { reason: "NON_INTEGER_REPS" } });
  });

  it("rejects an incomplete range (only one bound present)", () => {
    expect(repTargetFromRange({ minReps: 8, maxReps: null })).toEqual({
      ok: false,
      error: { reason: "INCOMPLETE_RANGE" },
    });
    expect(repTargetFromRange({ minReps: null, maxReps: 12 })).toEqual({
      ok: false,
      error: { reason: "INCOMPLETE_RANGE" },
    });
  });
});
