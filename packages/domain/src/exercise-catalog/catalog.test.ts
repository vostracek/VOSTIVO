import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  EXERCISE_EQUIPMENT_CATALOG_V1,
  EXERCISE_EQUIPMENT_CATALOG_VERSION_V1,
  createExerciseEquipmentCatalogLookup,
  exerciseEquipmentCatalogV1,
  validateExerciseEquipmentCatalog,
  type ExerciseEquipmentCatalogV1,
  type SubstitutionEdgeV1,
} from "./index.js";

/**
 * A TEST-LOCAL catalog for exercising edge semantics. The canonical catalog
 * deliberately has NO substitution edges yet (no approved pair exists —
 * spec §8); these edges are NOT product data and NOT physiological claims.
 */
const TEST_CATALOG: ExerciseEquipmentCatalogV1 = {
  version: "test-catalog",
  equipment: [
    { equipmentId: "eq-a", displayLabel: "A" },
    { equipmentId: "eq-b", displayLabel: "B" },
  ],
  exercises: [
    { exerciseRef: "x", displayName: "X", requiredEquipmentIds: ["eq-a"] },
    { exerciseRef: "y", displayName: "Y", requiredEquipmentIds: ["eq-b"] },
    { exerciseRef: "z", displayName: "Z", requiredEquipmentIds: [] },
  ],
  substitutions: [
    { sourceExerciseRef: "x", substituteExerciseRef: "z", compatibilityTier: "ROLE_COMPATIBLE", substitutionPriority: 3, prescriptionCompatibility: "REQUIRES_PRESCRIPTION_CHANGE" },
    { sourceExerciseRef: "x", substituteExerciseRef: "y", compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority: 1, prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION" },
  ],
};

const edge = (overrides: Partial<SubstitutionEdgeV1>): SubstitutionEdgeV1 => ({
  sourceExerciseRef: "x",
  substituteExerciseRef: "y",
  compatibilityTier: "ROLE_EQUIVALENT",
  substitutionPriority: 1,
  prescriptionCompatibility: "PRESERVE_WORKING_PRESCRIPTION",
  ...overrides,
});

function issuesOf(catalog: ExerciseEquipmentCatalogV1) {
  const result = validateExerciseEquipmentCatalog(catalog);
  return result.ok ? [] : result.error.map((issue) => issue.reason);
}

describe("Exercise & Equipment Reference Catalog V1 — canonical data", () => {
  it("1: the canonical catalog validates", () => {
    expect(validateExerciseEquipmentCatalog(EXERCISE_EQUIPMENT_CATALOG_V1)).toEqual({ ok: true, value: EXERCISE_EQUIPMENT_CATALOG_V1 });
  });

  it("2: the catalog version is the explicit, stable identifier (never a timestamp)", () => {
    expect(EXERCISE_EQUIPMENT_CATALOG_VERSION_V1).toBe("exercise-equipment-catalog/v1");
    expect(EXERCISE_EQUIPMENT_CATALOG_V1.version).toBe("exercise-equipment-catalog/v1");
    expect(exerciseEquipmentCatalogV1.version).toBe("exercise-equipment-catalog/v1");
  });

  it("3/4: equipment ids and exercise refs are unique", () => {
    const equipmentIds = EXERCISE_EQUIPMENT_CATALOG_V1.equipment.map((e) => e.equipmentId);
    const refs = EXERCISE_EQUIPMENT_CATALOG_V1.exercises.map((e) => e.exerciseRef);
    expect(new Set(equipmentIds).size).toBe(equipmentIds.length);
    expect(new Set(refs).size).toBe(refs.length);
    expect(issuesOf({ ...TEST_CATALOG, equipment: [...TEST_CATALOG.equipment, { equipmentId: "eq-a", displayLabel: "dup" }] })).toContain("DUPLICATE_EQUIPMENT_ID");
    expect(issuesOf({ ...TEST_CATALOG, exercises: [...TEST_CATALOG.exercises, { exerciseRef: "x", displayName: "dup", requiredEquipmentIds: [] }] })).toContain("DUPLICATE_EXERCISE_REF");
  });

  it("5/6: every requirement points at canonical equipment; empty requirements are valid (no fake bodyweight equipment)", () => {
    for (const exercise of EXERCISE_EQUIPMENT_CATALOG_V1.exercises) {
      for (const id of exercise.requiredEquipmentIds) expect(exerciseEquipmentCatalogV1.getEquipmentDefinition(id), `${exercise.exerciseRef} -> ${id}`).not.toBeNull();
    }
    expect(issuesOf({ ...TEST_CATALOG, exercises: [{ exerciseRef: "x", displayName: "X", requiredEquipmentIds: ["eq-missing"] }], substitutions: [] })).toEqual(["UNKNOWN_REQUIRED_EQUIPMENT"]);
    expect(createExerciseEquipmentCatalogLookup(TEST_CATALOG).getExerciseDefinition("z")?.requiredEquipmentIds).toEqual([]);
    expect(EXERCISE_EQUIPMENT_CATALOG_V1.equipment.map((e) => e.equipmentId)).not.toContain("bodyweight");
  });

  it("equipment ids are machine-readable kebab-case product vocabulary, not labels or brands", () => {
    for (const equipment of EXERCISE_EQUIPMENT_CATALOG_V1.equipment) {
      expect(equipment.equipmentId).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(equipment.displayLabel.length).toBeGreaterThan(0);
    }
  });

  it("7: an unknown ref never matches by display name (exact ref only)", () => {
    expect(exerciseEquipmentCatalogV1.getExerciseDefinition("Bench Press")).toBeNull();
    expect(exerciseEquipmentCatalogV1.getExerciseDefinition("BENCH-PRESS")).toBeNull();
    expect(exerciseEquipmentCatalogV1.resolveExerciseIdentity("Bench Press")).toEqual({ kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "UNKNOWN_EXERCISE_REF" });
    expect(exerciseEquipmentCatalogV1.resolveExerciseIdentity("bench-press")).toMatchObject({ kind: "CATALOG_EXERCISE", definition: { exerciseRef: "bench-press" } });
  });

  it("8: an unknown equipment id fails explicitly (null), never throws", () => {
    expect(exerciseEquipmentCatalogV1.getEquipmentDefinition("hammer-strength-iso-lateral-xyz")).toBeNull();
    expect(exerciseEquipmentCatalogV1.getEquipmentDefinition("Barbell (with plates)")).toBeNull();
  });

  it("9: a null exercise identity is unsupported", () => {
    expect(exerciseEquipmentCatalogV1.resolveExerciseIdentity(null)).toEqual({ kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "NULL_EXERCISE_REF" });
  });

  it("10/11/12/15: edge sources/targets must exist, no self edges, priorities are positive integers", () => {
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ sourceExerciseRef: "nope" })] })).toEqual(["UNKNOWN_SUBSTITUTION_SOURCE"]);
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ substituteExerciseRef: "nope" })] })).toEqual(["UNKNOWN_SUBSTITUTION_TARGET"]);
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ substituteExerciseRef: "x" })] })).toEqual(["SELF_SUBSTITUTION"]);
    for (const priority of [0, -1, 1.5, Number.NaN]) expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ substitutionPriority: priority })] })).toEqual(["INVALID_PRIORITY"]);
  });

  it("13/14: edges are directional — a reverse edge exists only if authored", () => {
    const lookup = createExerciseEquipmentCatalogLookup(TEST_CATALOG);
    expect(lookup.getSubstitutionEdges("x").map((e) => e.substituteExerciseRef)).toContain("y");
    expect(lookup.getSubstitutionEdges("y")).toEqual([]);
    const both = createExerciseEquipmentCatalogLookup({ ...TEST_CATALOG, substitutions: [...TEST_CATALOG.substitutions, edge({ sourceExerciseRef: "y", substituteExerciseRef: "x", substitutionPriority: 2 })] });
    expect(both.getSubstitutionEdges("y")).toEqual([edge({ sourceExerciseRef: "y", substituteExerciseRef: "x", substitutionPriority: 2 })]);
  });

  it("16: automatic (equivalent + preserving) priorities must be unique per source; duplicate identical edges are impossible", () => {
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({}), edge({ substituteExerciseRef: "z" })] })).toEqual(["AMBIGUOUS_EQUIVALENT_PRIORITY"]);
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({}), edge({ substitutionPriority: 2 })] })).toEqual(["DUPLICATE_EDGE"]);
    // A compatible edge may share a priority with an equivalent one: it is never automatic.
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({}), edge({ substituteExerciseRef: "z", compatibilityTier: "ROLE_COMPATIBLE" })] })).toEqual([]);
  });

  it("17/18: edge order is explicit priority (then ref), never declaration order", () => {
    const forward = createExerciseEquipmentCatalogLookup(TEST_CATALOG);
    const reversed = createExerciseEquipmentCatalogLookup({ ...TEST_CATALOG, substitutions: [...TEST_CATALOG.substitutions].reverse(), exercises: [...TEST_CATALOG.exercises].reverse() });
    expect(forward.getSubstitutionEdges("x").map((e) => e.substituteExerciseRef)).toEqual(["y", "z"]);
    expect(reversed.getSubstitutionEdges("x")).toEqual(forward.getSubstitutionEdges("x"));
    expect(reversed.getExerciseDefinition("y")).toEqual(forward.getExerciseDefinition("y"));
  });

  it("19/20: ROLE_COMPATIBLE stays distinguishable from ROLE_EQUIVALENT; prescription compatibility stays explicit; invalid enums are rejected", () => {
    const edges = createExerciseEquipmentCatalogLookup(TEST_CATALOG).getSubstitutionEdges("x");
    expect(edges.map((e) => [e.compatibilityTier, e.prescriptionCompatibility])).toEqual([
      ["ROLE_EQUIVALENT", "PRESERVE_WORKING_PRESCRIPTION"],
      ["ROLE_COMPATIBLE", "REQUIRES_PRESCRIPTION_CHANGE"],
    ]);
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ compatibilityTier: "SAME_MUSCLE" as never })] })).toEqual(["INVALID_COMPATIBILITY_TIER"]);
    expect(issuesOf({ ...TEST_CATALOG, substitutions: [edge({ prescriptionCompatibility: "SAME_WEIGHT" as never })] })).toEqual(["INVALID_PRESCRIPTION_COMPATIBILITY"]);
  });

  it("21/22/23/24: no load conversion, history, user availability or gym-specific state exists in the catalog", () => {
    const allowedKeys = new Set(["version", "equipment", "exercises", "substitutions", "equipmentId", "displayLabel", "exerciseRef", "displayName", "requiredEquipmentIds", "sourceExerciseRef", "substituteExerciseRef", "compatibilityTier", "substitutionPriority", "prescriptionCompatibility"]);
    const seen = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          seen.add(key);
          walk(child);
        }
      }
    };
    walk(EXERCISE_EQUIPMENT_CATALOG_V1);
    for (const key of seen) expect(allowedKeys.has(key), key).toBe(true);
    // The edge shape itself carries no load/history/availability either.
    expect(Object.keys(edge({})).sort()).toEqual(["compatibilityTier", "prescriptionCompatibility", "sourceExerciseRef", "substituteExerciseRef", "substitutionPriority"]);
    expect(JSON.stringify(EXERCISE_EQUIPMENT_CATALOG_V1)).not.toMatch(/load|kg|history|available|owned|gym|multiplier|ratio/i);
  });

  it("25/26: lookups never mutate canonical data, and returned references cannot be mutated", () => {
    const before = JSON.stringify(EXERCISE_EQUIPMENT_CATALOG_V1);
    const definition = exerciseEquipmentCatalogV1.getExerciseDefinition("bench-press")!;
    expect(Object.isFrozen(EXERCISE_EQUIPMENT_CATALOG_V1)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.requiredEquipmentIds)).toBe(true);
    expect(() => {
      (definition.requiredEquipmentIds as string[]).push("dumbbells");
    }).toThrow();
    expect(() => {
      (definition as { displayName: string }).displayName = "Hacked";
    }).toThrow();
    expect(() => {
      (EXERCISE_EQUIPMENT_CATALOG_V1.exercises as unknown[]).push({});
    }).toThrow();
    expect(Object.isFrozen(exerciseEquipmentCatalogV1.getSubstitutionEdges("bench-press"))).toBe(true);
    expect(exerciseEquipmentCatalogV1.getExerciseDefinition("bench-press")).toBe(definition);
    expect(JSON.stringify(EXERCISE_EQUIPMENT_CATALOG_V1)).toBe(before);
  });

  // --- Curated Substitution Seed V1 -------------------------------------------------------

  const NEW_EXERCISES: Record<string, string[]> = {
    "dumbbell-bench-press": ["dumbbells", "flat-bench"],
    "seated-dumbbell-overhead-press": ["dumbbells", "adjustable-bench"],
    "cable-lat-pulldown": ["cable-station"],
    "dumbbell-romanian-deadlift": ["dumbbells"],
    "seated-cable-row": ["cable-station"],
    "chest-supported-dumbbell-row": ["dumbbells", "adjustable-bench"],
    "hack-squat": ["hack-squat-machine"],
  };

  /** EXACTLY the tech-lead-approved edges: [source, substitute, priority]. */
  const APPROVED_EQUIVALENT: [string, string, number][] = [
    ["bench-press", "dumbbell-bench-press", 1],
    ["dumbbell-bench-press", "bench-press", 1],
    ["overhead-press", "seated-dumbbell-overhead-press", 1],
    ["seated-dumbbell-overhead-press", "overhead-press", 1],
    ["lat-pulldown", "cable-lat-pulldown", 1],
    ["cable-lat-pulldown", "lat-pulldown", 1],
    ["romanian-deadlift", "dumbbell-romanian-deadlift", 1],
    ["dumbbell-romanian-deadlift", "romanian-deadlift", 1],
    ["barbell-row", "seated-cable-row", 1],
    ["barbell-row", "chest-supported-dumbbell-row", 2],
    ["seated-cable-row", "chest-supported-dumbbell-row", 1],
    ["seated-cable-row", "barbell-row", 2],
    ["chest-supported-dumbbell-row", "seated-cable-row", 1],
    ["chest-supported-dumbbell-row", "barbell-row", 2],
  ];
  const APPROVED_COMPATIBLE: [string, string, number][] = [
    ["back-squat", "hack-squat", 1],
    ["back-squat", "leg-press", 2],
    ["leg-press", "hack-squat", 1],
    ["leg-press", "back-squat", 2],
    ["hack-squat", "leg-press", 1],
    ["hack-squat", "back-squat", 2],
    ["deadlift", "romanian-deadlift", 1],
    ["bench-press", "incline-dumbbell-press", 10],
  ];

  it("seed 1/2/3: the seven new exercises and hack-squat-machine resolve, with exactly the locked equipment", () => {
    for (const [ref, equipment] of Object.entries(NEW_EXERCISES)) {
      expect(exerciseEquipmentCatalogV1.resolveExerciseIdentity(ref), ref).toMatchObject({ kind: "CATALOG_EXERCISE" });
      expect(exerciseEquipmentCatalogV1.getExerciseDefinition(ref)?.requiredEquipmentIds, ref).toEqual(equipment);
    }
    expect(exerciseEquipmentCatalogV1.getEquipmentDefinition("hack-squat-machine")).toEqual({ equipmentId: "hack-squat-machine", displayLabel: "Hack Squat Machine" });
  });

  it("seed 4/5/6: the catalog holds EXACTLY the approved edges — every approved one present, nothing else (no synthesized reverse)", () => {
    const actual = EXERCISE_EQUIPMENT_CATALOG_V1.substitutions.map((e) => [e.sourceExerciseRef, e.substituteExerciseRef, e.substitutionPriority, e.compatibilityTier, e.prescriptionCompatibility]);
    const expected = [
      ...APPROVED_EQUIVALENT.map(([s, t, p]) => [s, t, p, "ROLE_EQUIVALENT", "PRESERVE_WORKING_PRESCRIPTION"]),
      ...APPROVED_COMPATIBLE.map(([s, t, p]) => [s, t, p, "ROLE_COMPATIBLE", "REQUIRES_PRESCRIPTION_CHANGE"]),
    ];
    expect([...actual].sort()).toEqual([...expected].sort());
    // Explicitly NOT authored: the reverse of one-way relations.
    for (const [source, target] of [["incline-dumbbell-press", "bench-press"], ["romanian-deadlift", "deadlift"], ["leg-press", "leg-press"]]) {
      expect(exerciseEquipmentCatalogV1.getSubstitutionEdges(source!).some((e) => e.substituteExerciseRef === target), `${source} -> ${target}`).toBe(false);
    }
  });

  it("seed (locked): squat-pattern, deadlift and incline relations are NEVER ROLE_EQUIVALENT", () => {
    const forbidden = [["back-squat", "leg-press"], ["leg-press", "back-squat"], ["back-squat", "hack-squat"], ["hack-squat", "back-squat"], ["leg-press", "hack-squat"], ["hack-squat", "leg-press"], ["deadlift", "romanian-deadlift"], ["romanian-deadlift", "deadlift"], ["bench-press", "incline-dumbbell-press"], ["incline-dumbbell-press", "bench-press"]];
    for (const [source, target] of forbidden) {
      const found = exerciseEquipmentCatalogV1.getSubstitutionEdges(source!).find((e) => e.substituteExerciseRef === target);
      expect(found?.compatibilityTier, `${source} -> ${target}`).not.toBe("ROLE_EQUIVALENT");
    }
  });

  it("seed 7/8/9: ordering is explicit priority; ROLE_COMPATIBLE stays visible in lookup", () => {
    expect(exerciseEquipmentCatalogV1.getSubstitutionEdges("bench-press").map((e) => [e.substituteExerciseRef, e.compatibilityTier])).toEqual([
      ["dumbbell-bench-press", "ROLE_EQUIVALENT"],
      ["incline-dumbbell-press", "ROLE_COMPATIBLE"],
    ]);
    expect(exerciseEquipmentCatalogV1.getSubstitutionEdges("barbell-row").map((e) => e.substituteExerciseRef)).toEqual(["seated-cable-row", "chest-supported-dumbbell-row"]);
    expect(exerciseEquipmentCatalogV1.getSubstitutionEdges("back-squat").map((e) => [e.substituteExerciseRef, e.compatibilityTier])).toEqual([
      ["hack-squat", "ROLE_COMPATIBLE"],
      ["leg-press", "ROLE_COMPATIBLE"],
    ]);
  });

  it("seed: exercises with no curated substitutes remain without any (no artificial coverage)", () => {
    for (const ref of ["face-pull", "leg-curl", "incline-dumbbell-press", "bulgarian-split-squat"]) expect(exerciseEquipmentCatalogV1.getSubstitutionEdges(ref), ref).toEqual([]);
  });

  it("27: every current first-party exerciseRef (dev Plan seed incl. SMALL_FIXTURE, mobile fixtures) is catalog-backed", () => {
    const sources = [
      new URL("../../../database/src/seed-dev-plan.ts", import.meta.url),
      new URL("../../../../apps/mobile/src/available-time/testing/fixtures.ts", import.meta.url),
    ];
    const refs = new Set<string>();
    for (const source of sources) for (const [, ref] of readFileSync(source, "utf8").matchAll(/exerciseRef: "([a-z0-9-]+)"/g)) refs.add(ref ?? "");
    expect(refs.size).toBeGreaterThanOrEqual(12);
    for (const ref of refs) expect(exerciseEquipmentCatalogV1.getExerciseDefinition(ref), ref).not.toBeNull();
  });

  it("27 (reported): test-only synthetic refs are explicitly NOT catalog-backed (unsupported by design)", () => {
    for (const ref of ["history-test-bench-press", "bench-press-gate-002", "bench-press-gate-003", "worker-progression-overhead-press", "incline-db-press", "incline-db-press-v2", "squat"]) {
      expect(exerciseEquipmentCatalogV1.resolveExerciseIdentity(ref)).toEqual({ kind: "UNSUPPORTED_EXERCISE_IDENTITY", reason: "UNKNOWN_EXERCISE_REF" });
    }
  });

  it("30: no infrastructure dependency, clock, randomness, DB or network in the catalog module", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|fetch\(/);
      for (const [, from] of source.matchAll(/from "([^"]+)"/g)) expect((from ?? "").startsWith("."), `${file} imports ${from}`).toBe(true);
    }
  });

  it("the validator reports an empty version", () => {
    expect(issuesOf({ ...TEST_CATALOG, version: " " })).toEqual(["EMPTY_VERSION"]);
  });
});
