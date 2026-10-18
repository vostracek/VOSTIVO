import { describe, expect, it } from "vitest";
import {
  resolveNextLoad,
  resolveNextLoadFromCapability,
  resolveNextLoadFromEnumeratedList,
  type EnumeratedListCapability,
  type LoadIncrementCapability,
  type LoadingCapabilityV1,
} from "./load-resolver.js";
import type { ExternalWeightLoad } from "./load.js";

function kgTotal(amountMilli: number): ExternalWeightLoad {
  return { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis: "TOTAL" };
}
function lbTotal(amountMilli: number): ExternalWeightLoad {
  return { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "LB", basis: "TOTAL" };
}
function kgPerImplement(amountMilli: number): ExternalWeightLoad {
  return { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis: "PER_IMPLEMENT" };
}
function lbPerImplement(amountMilli: number): ExternalWeightLoad {
  return { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "LB", basis: "PER_IMPLEMENT" };
}
function fixedIncrement(overrides: Partial<LoadIncrementCapability> = {}): LoadIncrementCapability {
  return { kind: "FIXED_INCREMENT", unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500, ...overrides };
}

describe("Load Resolver Stage 1 — resolveNextLoad (Progression Prerequisites V1)", () => {
  it("PROG-PREREQ-LR-001: KG TOTAL + valid increment", () => {
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(result).toEqual({ status: "RESOLVED", load: kgTotal(62500) });
  });

  it("PROG-PREREQ-LR-002: LB TOTAL + valid increment", () => {
    const result = resolveNextLoad(lbTotal(135000), fixedIncrement({ unit: "LB", incrementAmountMilli: 5000 }));
    expect(result).toEqual({ status: "RESOLVED", load: lbTotal(140000) });
  });

  it("PROG-PREREQ-LR-003: KG PER_IMPLEMENT + valid increment — stays PER_IMPLEMENT, never summed to TOTAL", () => {
    const result = resolveNextLoad(
      kgPerImplement(40000),
      fixedIncrement({ basis: "PER_IMPLEMENT", incrementAmountMilli: 2000 }),
    );
    expect(result).toEqual({ status: "RESOLVED", load: kgPerImplement(42000) });
    // Explicitly not 44000 (double-counted) and not 84000 (summed to TOTAL).
    if (result.status === "RESOLVED") {
      expect(result.load.amountMilli).not.toBe(44000);
      expect(result.load.amountMilli).not.toBe(84000);
      expect(result.load.basis).toBe("PER_IMPLEMENT");
    }
  });

  it("PROG-PREREQ-LR-004: LB PER_IMPLEMENT + valid increment", () => {
    const result = resolveNextLoad(
      lbPerImplement(90000),
      fixedIncrement({ unit: "LB", basis: "PER_IMPLEMENT", incrementAmountMilli: 5000 }),
    );
    expect(result).toEqual({ status: "RESOLVED", load: lbPerImplement(95000) });
  });

  it("PROG-PREREQ-LR-005: zero increment is rejected as NO_SUITABLE_INCREMENT", () => {
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: 0 }));
    expect(result).toEqual({ status: "NO_SUITABLE_INCREMENT" });
  });

  it("PROG-PREREQ-LR-006: negative increment is rejected as NO_SUITABLE_INCREMENT", () => {
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: -2500 }));
    expect(result).toEqual({ status: "NO_SUITABLE_INCREMENT" });
  });

  it("PROG-PREREQ-LR-007: unit mismatch is rejected as INVALID_CAPABILITY, never silently converted", () => {
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement({ unit: "LB", incrementAmountMilli: 5000 }));
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "UNIT_MISMATCH" });
  });

  it("PROG-PREREQ-LR-008: basis mismatch is rejected as INVALID_CAPABILITY, never silently reinterpreted", () => {
    const result = resolveNextLoad(
      kgPerImplement(40000),
      fixedIncrement({ basis: "TOTAL", incrementAmountMilli: 2500 }),
    );
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "BASIS_MISMATCH" });
  });

  it("PROG-PREREQ-LR-009: integer exactness — 2.5 kg is 2500 milli, no float drift", () => {
    const result = resolveNextLoad(kgTotal(100000), fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(result.status).toBe("RESOLVED");
    if (result.status === "RESOLVED") {
      expect(result.load.amountMilli).toBe(102500);
      expect(Number.isInteger(result.load.amountMilli)).toBe(true);
    }
  });

  it("PROG-PREREQ-LR-010: current load is never mutated", () => {
    const current = kgTotal(60000);
    const snapshot = { ...current };
    resolveNextLoad(current, fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(current).toEqual(snapshot);
  });

  it("PROG-PREREQ-LR-011: exactly one increment is applied, never a multi-step jump", () => {
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(result.status).toBe("RESOLVED");
    if (result.status === "RESOLVED") {
      // one increment above 60000, not two (65000) or more.
      expect(result.load.amountMilli).toBe(62500);
    }
  });

  it("PROG-PREREQ-LR-012: an unsafe/overflowing result is rejected as INVALID_CAPABILITY, never a corrupted number", () => {
    const result = resolveNextLoad(kgTotal(Number.MAX_SAFE_INTEGER - 1), fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "OVERFLOW" });
  });

  it("PROG-PREREQ-LR-013: deterministic — identical input always produces an identical result", () => {
    const first = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: 2500 }));
    const second = resolveNextLoad(kgTotal(60000), fixedIncrement({ incrementAmountMilli: 2500 }));
    expect(first).toEqual(second);
  });

  it("PROG-PREREQ-LR-014: unsupported load kind is excluded by the type signature (Stage 1 boundary), not a runtime case — ExternalWeightLoad is the only accepted shape", () => {
    // Compile-time proof: resolveNextLoad's first parameter is typed
    // ExternalWeightLoad specifically (the only LoadKindV1 in Stage 1 —
    // see packages/domain/src/load/load.ts's LOAD_KINDS_V1). There is no
    // other kind to construct and pass here without a type error, which
    // is the point: this boundary is enforced by TypeScript, not a
    // runtime branch that could silently mishandle an unknown kind.
    const result = resolveNextLoad(kgTotal(60000), fixedIncrement());
    expect(result.status).toBe("RESOLVED");
  });
});

function enumeratedList(overrides: Partial<EnumeratedListCapability> = {}): EnumeratedListCapability {
  return {
    kind: "ENUMERATED_LIST",
    unit: "KG",
    basis: "PER_IMPLEMENT",
    loadsMilli: [20000, 22000, 24000, 26000],
    ...overrides,
  };
}

describe("Load Resolver — resolveNextLoadFromEnumeratedList (Loading Capability V1)", () => {
  it("LOADCAP-LR-001: current value present, not the last entry — resolves to the immediate next-higher entry", () => {
    const result = resolveNextLoadFromEnumeratedList(kgPerImplement(24000), enumeratedList());
    expect(result).toEqual({ status: "RESOLVED", load: kgPerImplement(26000) });
  });

  it("LOADCAP-LR-002: first entry resolves to the second", () => {
    const result = resolveNextLoadFromEnumeratedList(kgPerImplement(20000), enumeratedList());
    expect(result).toEqual({ status: "RESOLVED", load: kgPerImplement(22000) });
  });

  it("LOADCAP-LR-003: current value is the last (top) entry — NO_SUITABLE_INCREMENT, never wraps or invents a higher value", () => {
    const result = resolveNextLoadFromEnumeratedList(kgPerImplement(26000), enumeratedList());
    expect(result).toEqual({ status: "NO_SUITABLE_INCREMENT" });
  });

  it("LOADCAP-LR-004: current value absent from the list — CURRENT_LOAD_UNSUPPORTED, never rounded to a neighbor", () => {
    const result = resolveNextLoadFromEnumeratedList(kgPerImplement(23000), enumeratedList());
    expect(result).toEqual({ status: "CURRENT_LOAD_UNSUPPORTED" });
  });

  it("LOADCAP-LR-005: unit mismatch — INVALID_CAPABILITY, never converted", () => {
    const result = resolveNextLoadFromEnumeratedList(lbPerImplement(24000), enumeratedList());
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "UNIT_MISMATCH" });
  });

  it("LOADCAP-LR-006: basis mismatch — INVALID_CAPABILITY, never reinterpreted", () => {
    const result = resolveNextLoadFromEnumeratedList(kgTotal(24000), enumeratedList());
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "BASIS_MISMATCH" });
  });

  it("LOADCAP-LR-007: current is never mutated", () => {
    const current = kgPerImplement(24000);
    const snapshot = { ...current };
    resolveNextLoadFromEnumeratedList(current, enumeratedList());
    expect(current).toEqual(snapshot);
  });

  it("LOADCAP-LR-008: deterministic — identical input always produces an identical result", () => {
    const first = resolveNextLoadFromEnumeratedList(kgPerImplement(22000), enumeratedList());
    const second = resolveNextLoadFromEnumeratedList(kgPerImplement(22000), enumeratedList());
    expect(first).toEqual(second);
  });

  it("LOADCAP-LR-009: a single-entry list where current is that entry — NO_SUITABLE_INCREMENT", () => {
    const result = resolveNextLoadFromEnumeratedList(kgPerImplement(20000), enumeratedList({ loadsMilli: [20000] }));
    expect(result).toEqual({ status: "NO_SUITABLE_INCREMENT" });
  });

  it("LOADCAP-LR-012: fail-closed — an unsorted (malformed) list is rejected as INVALID_CAPABILITY/MALFORMED_CAPABILITY, never resolved", () => {
    // The exact case empirically proven to previously return a WRONG,
    // lower "next" value (22000 < current 24000) before this fail-closed
    // check existed.
    const result = resolveNextLoadFromEnumeratedList(
      kgPerImplement(24000),
      enumeratedList({ loadsMilli: [20000, 24000, 22000] }),
    );
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "MALFORMED_CAPABILITY" });
  });

  it("LOADCAP-LR-013: fail-closed — a list with a duplicate entry is rejected as INVALID_CAPABILITY/MALFORMED_CAPABILITY, never resolved", () => {
    const result = resolveNextLoadFromEnumeratedList(
      kgPerImplement(22000),
      enumeratedList({ loadsMilli: [20000, 22000, 22000, 24000] }),
    );
    expect(result).toEqual({ status: "INVALID_CAPABILITY", reason: "MALFORMED_CAPABILITY" });
  });

  it("LOADCAP-LR-014: fail-closed check never mutates the input list or current load", () => {
    const loadsMilli = [20000, 24000, 22000];
    const current = kgPerImplement(24000);
    const capability = enumeratedList({ loadsMilli });
    resolveNextLoadFromEnumeratedList(current, capability);
    expect(loadsMilli).toEqual([20000, 24000, 22000]);
    expect(current).toEqual(kgPerImplement(24000));
  });
});

describe("Load Resolver — resolveNextLoadFromCapability (unified dispatcher, Loading Capability V1)", () => {
  it("LOADCAP-LR-010: dispatches FIXED_INCREMENT to resolveNextLoad — identical result", () => {
    const capability: LoadingCapabilityV1 = fixedIncrement({ incrementAmountMilli: 2500 });
    const viaDispatcher = resolveNextLoadFromCapability(kgTotal(60000), capability);
    const direct = resolveNextLoad(kgTotal(60000), capability);
    expect(viaDispatcher).toEqual(direct);
    expect(viaDispatcher).toEqual({ status: "RESOLVED", load: kgTotal(62500) });
  });

  it("LOADCAP-LR-011: dispatches ENUMERATED_LIST to resolveNextLoadFromEnumeratedList — identical result", () => {
    const capability: LoadingCapabilityV1 = enumeratedList();
    const viaDispatcher = resolveNextLoadFromCapability(kgPerImplement(24000), capability);
    const direct = resolveNextLoadFromEnumeratedList(kgPerImplement(24000), capability);
    expect(viaDispatcher).toEqual(direct);
    expect(viaDispatcher).toEqual({ status: "RESOLVED", load: kgPerImplement(26000) });
  });
});
