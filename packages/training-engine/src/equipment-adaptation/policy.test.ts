import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { EquipmentAdaptationDecisionDataV1 } from "./decision-data.js";
import type { EquipmentAdaptationExerciseV1, EquipmentAdaptationInputV1, SubstituteCandidateV1 } from "./input.js";
import { equipmentAdaptationPolicyV1, evaluateEquipmentAdaptation } from "./policy.js";
import { EQUIPMENT_ADAPTATION_POLICY_VERSION_V1 } from "./vocabulary.js";

// --- fixture: an ordinary hypertrophy session ----------------------------------------------
// Equipment ids are stable opaque identities; names are never compared.
const ALL_EQUIPMENT = ["eq-barbell", "eq-rack", "eq-bench", "eq-dumbbells", "eq-hack-squat", "eq-leg-press", "eq-leg-curl", "eq-cable"];
const KG = (kg: number) => ({ kind: "EXTERNAL_WEIGHT" as const, amountMilli: kg * 1000, unit: "KG" as const, basis: "TOTAL" as const });

function candidate(id: string, priority: number, equipment: string[], overrides: Partial<SubstituteCandidateV1> = {}): SubstituteCandidateV1 {
  return { substituteExerciseId: id, compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority: priority, requiredEquipmentIds: equipment, prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION", ...overrides };
}

function exercise(plannedExerciseId: string, exerciseId: string, order: number, equipment: string[], candidates: SubstituteCandidateV1[] = [], overrides: Partial<EquipmentAdaptationExerciseV1> = {}): EquipmentAdaptationExerciseV1 {
  return {
    plannedExerciseId,
    exerciseId,
    order,
    requiredEquipmentIds: equipment,
    substitutionPolicy: "ALLOW_TEMPORARY",
    sets: [
      { plannedSetId: `${plannedExerciseId}-w1`, order: 1, setType: "WARM_UP", targetReps: { kind: "EXACT", reps: 10 }, restSeconds: 60, targetLoad: KG(40) },
      { plannedSetId: `${plannedExerciseId}-s1`, order: 2, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 120, targetLoad: KG(100) },
      { plannedSetId: `${plannedExerciseId}-s2`, order: 3, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 120, targetLoad: KG(100) },
      { plannedSetId: `${plannedExerciseId}-s3`, order: 4, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: null, targetLoad: KG(100) },
    ],
    availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 2 },
    candidates,
    ...overrides,
  };
}

const HACK_SQUAT = exercise("pe-hack", "hack-squat", 1, ["eq-hack-squat"], [
  candidate("leg-press", 1, ["eq-leg-press"]),
  candidate("goblet-squat", 2, ["eq-dumbbells"]),
  candidate("back-squat", 3, ["eq-barbell", "eq-rack"], { compatibilityTier: "ROLE_COMPATIBLE" }),
]);
const BENCH = exercise("pe-bench", "barbell-bench-press", 2, ["eq-barbell", "eq-bench"], [candidate("dumbbell-bench-press", 1, ["eq-dumbbells", "eq-bench"])]);
const ROW = exercise("pe-row", "barbell-row", 3, ["eq-barbell"], [candidate("cable-row", 1, ["eq-cable"])]);
const LEG_CURL = exercise("pe-curl", "leg-curl", 4, ["eq-leg-curl"], [], { availableTime: { priorityTier: "TIER_3", minimumWorkingSets: 0 } });
const CALF_RAISE = exercise("pe-calf", "standing-calf-raise", 5, [], [], { availableTime: null });

function input(overrides: Partial<EquipmentAdaptationInputV1> = {}): EquipmentAdaptationInputV1 {
  return { exercises: [HACK_SQUAT, BENCH, ROW, LEG_CURL, CALF_RAISE], availableEquipmentIds: ALL_EQUIPMENT, athleteBlockedExerciseIds: [], ...overrides };
}

const without = (...ids: string[]) => ALL_EQUIPMENT.filter((id) => !ids.includes(id));

function decide(value: EquipmentAdaptationInputV1): EquipmentAdaptationDecisionDataV1 {
  const result = evaluateEquipmentAdaptation(value);
  if (!result.ok) throw new Error(`invalid input: ${JSON.stringify(result.error)}`);
  return result.value.data;
}

function adjust(value: EquipmentAdaptationInputV1): Extract<EquipmentAdaptationDecisionDataV1, { resultKind: "ADJUST_SESSION" }> {
  const data = decide(value);
  if (data.resultKind !== "ADJUST_SESSION") throw new Error(`expected ADJUST_SESSION, got ${data.resultKind} ${data.reasonCode}`);
  return data;
}

function review(value: EquipmentAdaptationInputV1): Extract<EquipmentAdaptationDecisionDataV1, { resultKind: "REVIEW_REQUIRED" }> {
  const data = decide(value);
  if (data.resultKind !== "REVIEW_REQUIRED") throw new Error(`expected REVIEW_REQUIRED, got ${data.resultKind}`);
  return data;
}

describe("equipment-adaptation/v1 — pure deterministic substitution policy", () => {
  it("exposes its policy version and EngineDecision envelope", () => {
    expect(EQUIPMENT_ADAPTATION_POLICY_VERSION_V1).toBe("equipment-adaptation/v1");
    const result = evaluateEquipmentAdaptation(input());
    expect(result.ok && result.value.kind).toBe("equipment-adaptation");
    expect(result.ok && result.value.version).toEqual({ engine: "equipment-adaptation", policy: "v1" });
  });

  it("1: all equipment available -> NO_CHANGE with no mapping", () => {
    expect(decide(input())).toEqual({ resultKind: "NO_CHANGE", reasonCode: "ALL_EQUIPMENT_AVAILABLE" });
  });

  it("an exercise needing no equipment stays available even with an empty equipment context", () => {
    expect(decide(input({ exercises: [CALF_RAISE], availableEquipmentIds: [] }))).toMatchObject({ resultKind: "NO_CHANGE" });
  });

  it("2/3/4/5: one unavailable exercise + one eligible equivalent -> ADJUST_SESSION; only it changes, in its own position; order/identities of the rest untouched", () => {
    const data = adjust(input({ availableEquipmentIds: without("eq-hack-squat") }));
    expect(data.replacements.map((r) => [r.plannedExerciseId, r.authoredExerciseId, r.substituteExerciseId, r.order, r.reasonCode])).toEqual([
      ["pe-hack", "hack-squat", "leg-press", 1, "TEMPORARY_EQUIPMENT_UNAVAILABLE"],
    ]);
    expect(data.session).toEqual([
      { plannedExerciseId: "pe-hack", order: 1, authoredExerciseId: "hack-squat", effectiveExerciseId: "leg-press", substituted: true },
      { plannedExerciseId: "pe-bench", order: 2, authoredExerciseId: "barbell-bench-press", effectiveExerciseId: "barbell-bench-press", substituted: false },
      { plannedExerciseId: "pe-row", order: 3, authoredExerciseId: "barbell-row", effectiveExerciseId: "barbell-row", substituted: false },
      { plannedExerciseId: "pe-curl", order: 4, authoredExerciseId: "leg-curl", effectiveExerciseId: "leg-curl", substituted: false },
      { plannedExerciseId: "pe-calf", order: 5, authoredExerciseId: "standing-calf-raise", effectiveExerciseId: "standing-calf-raise", substituted: false },
    ]);
  });

  it("6/7/8/9/10/29: the working prescription is preserved (set count/types, reps, rest, priority/minimum); RIR is not modelled so nothing is invented", () => {
    const [replacement] = adjust(input({ availableEquipmentIds: without("eq-hack-squat") })).replacements;
    expect(replacement!.prescription).toEqual({
      policy: "PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD",
      workingSetCount: 3,
      sets: [
        { plannedSetId: "pe-hack-w1", order: 1, setType: "WARM_UP", targetReps: { kind: "EXACT", reps: 10 }, restSeconds: 60 },
        { plannedSetId: "pe-hack-s1", order: 2, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 120 },
        { plannedSetId: "pe-hack-s2", order: 3, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: 120 },
        { plannedSetId: "pe-hack-s3", order: 4, setType: "WORKING", targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, restSeconds: null },
      ],
      availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 2 },
      workingLoadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
      warmUpLoadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
    });
    expect(JSON.stringify(replacement)).not.toMatch(/rir|effort/i);
  });

  it("11/31: load is NEVER copied — no working or warm-up kilograms anywhere in the decision", () => {
    const data = adjust(input({ availableEquipmentIds: without("eq-hack-squat") }));
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/targetLoad|amountMilli|"KG"/);
    for (const set of data.replacements[0]!.prescription.sets) expect(set).not.toHaveProperty("targetLoad");
  });

  it("a session with no warm-up sets needs no warm-up load resolution", () => {
    const noWarmUp = { ...HACK_SQUAT, sets: HACK_SQUAT.sets.filter((s) => s.setType === "WORKING") };
    expect(adjust(input({ exercises: [noWarmUp], availableEquipmentIds: without("eq-hack-squat") })).replacements[0]!.prescription.warmUpLoadResolution).toBeNull();
  });

  it("12: the substitute keeps its OWN exercise identity; the authored intent stays separately recorded", () => {
    const [replacement] = adjust(input({ exercises: [BENCH], availableEquipmentIds: without("eq-barbell") })).replacements;
    expect(replacement).toMatchObject({ authoredExerciseId: "barbell-bench-press", substituteExerciseId: "dumbbell-bench-press" });
    expect(replacement!.substituteExerciseId).not.toBe(replacement!.authoredExerciseId);
  });

  it("13/21: a candidate needing unavailable equipment is rejected; the next unique best priority wins", () => {
    const data = adjust(input({ exercises: [HACK_SQUAT], availableEquipmentIds: without("eq-hack-squat", "eq-leg-press") }));
    expect(data.replacements[0]!.substituteExerciseId).toBe("goblet-squat");
  });

  it("14: an athlete-blocked candidate is ineligible even when its equipment exists", () => {
    const data = adjust(input({ exercises: [HACK_SQUAT], availableEquipmentIds: without("eq-hack-squat"), athleteBlockedExerciseIds: ["leg-press"] }));
    expect(data.replacements[0]!.substituteExerciseId).toBe("goblet-squat");
  });

  it("15: the original exercise can never substitute itself", () => {
    const selfOnly = exercise("pe-x", "hack-squat", 1, ["eq-hack-squat"], [candidate("hack-squat", 1, [])]);
    expect(review(input({ exercises: [selfOnly], availableEquipmentIds: [] })).reasonCode).toBe("NO_AVAILABLE_SUBSTITUTE");
  });

  it("16: only ROLE_COMPATIBLE candidates available -> REVIEW_REQUIRED (never auto-selected)", () => {
    const data = review(input({ exercises: [HACK_SQUAT], availableEquipmentIds: without("eq-hack-squat", "eq-leg-press", "eq-dumbbells") }));
    expect(data).toEqual({ resultKind: "REVIEW_REQUIRED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE", unresolved: [{ plannedExerciseId: "pe-hack", authoredExerciseId: "hack-squat", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" }], unavailablePlannedExerciseIds: ["pe-hack"] });
  });

  it("17: no curated candidates -> REVIEW_REQUIRED NO_CURATED_SUBSTITUTE", () => {
    expect(review(input({ availableEquipmentIds: without("eq-leg-curl") })).reasonCode).toBe("NO_CURATED_SUBSTITUTE");
  });

  it("18: every curated candidate unavailable -> REVIEW_REQUIRED NO_AVAILABLE_SUBSTITUTE", () => {
    expect(review(input({ exercises: [ROW], availableEquipmentIds: without("eq-barbell", "eq-cable") })).reasonCode).toBe("NO_AVAILABLE_SUBSTITUTE");
  });

  it("19: a LOCKED unavailable exercise -> REVIEW_REQUIRED LOCKED_EXERCISE_UNAVAILABLE, even with a perfect candidate", () => {
    const locked = { ...BENCH, substitutionPolicy: "LOCKED" as const };
    expect(review(input({ exercises: [locked], availableEquipmentIds: without("eq-barbell") })).reasonCode).toBe("LOCKED_EXERCISE_UNAVAILABLE");
  });

  it("a LOCKED exercise whose equipment IS available is simply unchanged", () => {
    expect(decide(input({ exercises: [{ ...BENCH, substitutionPolicy: "LOCKED" }] }))).toMatchObject({ resultKind: "NO_CHANGE" });
  });

  it("20: two eligible candidates sharing the best priority -> AMBIGUOUS_SUBSTITUTION (never a guess)", () => {
    const tied = exercise("pe-x", "hack-squat", 1, ["eq-hack-squat"], [candidate("leg-press", 1, ["eq-leg-press"]), candidate("goblet-squat", 1, ["eq-dumbbells"])]);
    expect(review(input({ exercises: [tied], availableEquipmentIds: without("eq-hack-squat") })).reasonCode).toBe("AMBIGUOUS_SUBSTITUTION");
  });

  it("a tie that is broken by an earlier filter (equipment) is not ambiguous", () => {
    const tied = exercise("pe-x", "hack-squat", 1, ["eq-hack-squat"], [candidate("leg-press", 1, ["eq-leg-press"]), candidate("goblet-squat", 1, ["eq-dumbbells"])]);
    expect(adjust(input({ exercises: [tied], availableEquipmentIds: without("eq-hack-squat", "eq-dumbbells") })).replacements[0]!.substituteExerciseId).toBe("leg-press");
  });

  it("22: candidate row order never matters", () => {
    const reversed = { ...HACK_SQUAT, candidates: [...HACK_SQUAT.candidates].reverse() };
    const a = decide(input({ availableEquipmentIds: without("eq-hack-squat") }));
    const b = decide(input({ exercises: [reversed, BENCH, ROW, LEG_CURL, CALF_RAISE], availableEquipmentIds: without("eq-hack-squat") }));
    expect(b).toEqual(a);
  });

  it("exercise row order never matters (authored `order` is the only authority)", () => {
    const shuffled = input({ exercises: [CALF_RAISE, ROW, HACK_SQUAT, LEG_CURL, BENCH], availableEquipmentIds: without("eq-hack-squat") });
    expect(decide(shuffled)).toEqual(decide(input({ availableEquipmentIds: without("eq-hack-squat") })));
  });

  it("23: a candidate already planned in the session is not eligible — the next candidate is used", () => {
    const pressSlot = exercise("pe-press", "leg-press", 2, ["eq-leg-press"]);
    const data = adjust(input({ exercises: [HACK_SQUAT, pressSlot], availableEquipmentIds: without("eq-hack-squat") }));
    expect(data.replacements[0]!.substituteExerciseId).toBe("goblet-squat");
  });

  it("24: no candidate left after the conflict -> REVIEW_REQUIRED SUBSTITUTE_CONFLICT (slots never merged)", () => {
    const cableSlot = exercise("pe-cable", "cable-row", 4, ["eq-cable"]);
    expect(review(input({ exercises: [ROW, cableSlot], availableEquipmentIds: without("eq-barbell") })).reasonCode).toBe("SUBSTITUTE_CONFLICT");
  });

  it("25/26: two unavailable exercises with unique non-conflicting substitutes -> ADJUST_SESSION, in authored order", () => {
    const data = adjust(input({ availableEquipmentIds: without("eq-hack-squat", "eq-barbell") }));
    expect(data.replacements.map((r) => [r.order, r.authoredExerciseId, r.substituteExerciseId])).toEqual([
      [1, "hack-squat", "leg-press"],
      [2, "barbell-bench-press", "dumbbell-bench-press"],
      [3, "barbell-row", "cable-row"],
    ]);
    expect(data.session.map((s) => s.plannedExerciseId)).toEqual(["pe-hack", "pe-bench", "pe-row", "pe-curl", "pe-calf"]);
  });

  it("an earlier substitution takes its identity away from a later slot (sequential, explainable)", () => {
    const first = exercise("pe-a", "a", 1, ["eq-hack-squat"], [candidate("shared", 1, [])]);
    const second = exercise("pe-b", "b", 2, ["eq-leg-curl"], [candidate("shared", 1, []), candidate("fallback", 2, [])]);
    const data = adjust(input({ exercises: [second, first], availableEquipmentIds: [] }));
    expect(data.replacements.map((r) => [r.plannedExerciseId, r.substituteExerciseId])).toEqual([["pe-a", "shared"], ["pe-b", "fallback"]]);
    const noFallback = { ...second, candidates: [candidate("shared", 1, [])] };
    expect(review(input({ exercises: [first, noFallback], availableEquipmentIds: [] })).unresolved).toEqual([{ plannedExerciseId: "pe-b", authoredExerciseId: "b", reasonCode: "SUBSTITUTE_CONFLICT" }]);
  });

  it("27/28: one unresolved affected exercise makes the WHOLE decision REVIEW_REQUIRED — no partial replacements are returned", () => {
    const data = review(input({ availableEquipmentIds: without("eq-hack-squat", "eq-leg-curl") }));
    expect(data).toEqual({
      resultKind: "REVIEW_REQUIRED",
      reasonCode: "NO_CURATED_SUBSTITUTE",
      unresolved: [{ plannedExerciseId: "pe-curl", authoredExerciseId: "leg-curl", reasonCode: "NO_CURATED_SUBSTITUTE" }],
      unavailablePlannedExerciseIds: ["pe-hack", "pe-curl"],
    });
    expect(data).not.toHaveProperty("replacements");
  });

  it("30: a role-equivalent candidate that cannot keep the prescription -> REVIEW_REQUIRED UNSUPPORTED_PRESCRIPTION_COMPATIBILITY", () => {
    const changing = exercise("pe-x", "hack-squat", 1, ["eq-hack-squat"], [candidate("leg-press", 1, ["eq-leg-press"], { prescriptionCompatibility: "REQUIRES_PRESCRIPTION_CHANGE" })]);
    expect(review(input({ exercises: [changing], availableEquipmentIds: without("eq-hack-squat") })).reasonCode).toBe("UNSUPPORTED_PRESCRIPTION_COMPATIBILITY");
  });

  it("the first unresolved exercise (authored order) names the top-level reason; every unresolved one is listed", () => {
    const locked = { ...BENCH, substitutionPolicy: "LOCKED" as const };
    const data = review(input({ exercises: [HACK_SQUAT, locked, ROW, LEG_CURL], availableEquipmentIds: without("eq-barbell", "eq-leg-curl") }));
    expect(data.reasonCode).toBe("LOCKED_EXERCISE_UNAVAILABLE");
    expect(data.unresolved.map((u) => [u.plannedExerciseId, u.reasonCode])).toEqual([["pe-bench", "LOCKED_EXERCISE_UNAVAILABLE"], ["pe-curl", "NO_CURATED_SUBSTITUTE"]]);
  });

  it("32/33: no progression or Athlete Memory output of any kind", () => {
    const serialized = JSON.stringify(decide(input({ availableEquipmentIds: without("eq-hack-squat") })));
    expect(serialized).not.toMatch(/progression|regression|plateau|deload|memory|INCREASE_LOAD|PR\b/i);
  });

  it("34: athlete mode cannot change the result (the input has no mode; an extra field is ignored)", () => {
    const base = decide(input({ availableEquipmentIds: without("eq-hack-squat") }));
    for (const mode of ["GUIDED", "ADAPTIVE", "EXPERT"]) {
      expect(decide({ ...input({ availableEquipmentIds: without("eq-hack-squat") }), experienceMode: mode } as EquipmentAdaptationInputV1)).toEqual(base);
    }
  });

  it("35: Available-Time priority/minimum never change candidate compatibility or ranking — they only ride along", () => {
    const tier3 = { ...HACK_SQUAT, availableTime: { priorityTier: "TIER_3" as const, minimumWorkingSets: 0 } };
    const a = adjust(input({ exercises: [HACK_SQUAT], availableEquipmentIds: without("eq-hack-squat") }));
    const b = adjust(input({ exercises: [tier3], availableEquipmentIds: without("eq-hack-squat") }));
    expect(b.replacements[0]!.substituteExerciseId).toBe(a.replacements[0]!.substituteExerciseId);
    expect(b.replacements[0]!.prescription.availableTime).toEqual({ priorityTier: "TIER_3", minimumWorkingSets: 0 });
  });

  it("36: the same input always yields a structurally identical decision", () => {
    const value = input({ availableEquipmentIds: without("eq-hack-squat", "eq-barbell") });
    expect(evaluateEquipmentAdaptation(value)).toEqual(evaluateEquipmentAdaptation(value));
    expect(equipmentAdaptationPolicyV1.decide(value)).toEqual(equipmentAdaptationPolicyV1.decide(value));
  });

  it("37: the input is never mutated", () => {
    const value = input({ exercises: [CALF_RAISE, ROW, HACK_SQUAT, BENCH], availableEquipmentIds: without("eq-hack-squat", "eq-barbell") });
    const before = structuredClone(value);
    decide(value);
    review(input({ exercises: [{ ...BENCH, substitutionPolicy: "LOCKED" }], availableEquipmentIds: [] }));
    expect(value).toEqual(before);
  });

  it("38: no infrastructure dependencies in the module (no clock, randomness, framework, DB, network, filesystem)", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      // Code-level calls only (comments may discuss them).
      expect(source, file).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|fetch\(/);
      for (const [, from] of source.matchAll(/from "([^"]+)"/g)) expect(from === "@vostivo/domain" || (from ?? "").startsWith("."), `${file} imports ${from}`).toBe(true);
    }
  });

  it("structurally invalid input is a typed error, never a decision", () => {
    expect(evaluateEquipmentAdaptation(input({ exercises: [HACK_SQUAT, { ...BENCH, order: 1 }] }))).toEqual({ ok: false, error: { reason: "DUPLICATE_ORDER", plannedExerciseId: "pe-bench" } });
    expect(evaluateEquipmentAdaptation(input({ exercises: [{ ...HACK_SQUAT, candidates: [candidate("leg-press", 0, [])] }] }))).toMatchObject({ ok: false, error: { reason: "INVALID_SUBSTITUTION_PRIORITY" } });
    expect(evaluateEquipmentAdaptation(input({ exercises: [{ ...HACK_SQUAT, candidates: [candidate("leg-press", 1, []), candidate("leg-press", 2, [])] }] }))).toMatchObject({ ok: false, error: { reason: "DUPLICATE_CANDIDATE" } });
    expect(evaluateEquipmentAdaptation(input({ exercises: [{ ...HACK_SQUAT, exerciseId: "" }] }))).toMatchObject({ ok: false, error: { reason: "EMPTY_ID" } });
    expect(evaluateEquipmentAdaptation(input({ exercises: [{ ...HACK_SQUAT, availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 4 } }] }))).toMatchObject({ ok: false, error: { reason: "INVALID_AVAILABLE_TIME" } });
    expect(evaluateEquipmentAdaptation(input({ exercises: [{ ...HACK_SQUAT, substitutionPolicy: "MAYBE" as never }] }))).toMatchObject({ ok: false, error: { reason: "UNSUPPORTED_SUBSTITUTION_POLICY" } });
  });
});
