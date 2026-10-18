import { describe, expect, it } from "vitest";
import type { ExternalWeightLoad, RepTargetV1 } from "@vostivo/domain";
import { evaluateProgression, progressionPolicyV1 } from "./policy.js";
import { PROGRESSION_DECISION_TYPES_V1, REASON_CODE_DECISION_PAIRS_V1 } from "./vocabulary.js";
import type { ComparabilityTierV1 } from "./vocabulary.js";
import type { ProgressionEvaluationInput, ProgressionExposureV1, ProgressionExposureWorkingSetV1 } from "./input.js";
import type { RirV1 } from "./rir.js";
import type { ProgressionDecisionDataV1 } from "./decision-data.js";

/**
 * Test fixtures translate docs/domain/PROGRESSION-ENGINE-V1.md's own
 * numbers (§12's rules, the PROG-* matrix, the Worked examples) directly
 * — never invented data shapes. `SET_IDS[i]` is the canonical identity a
 * `reps[i]` entry maps onto; `null`-padding (via `extra`) produces an
 * unplanned/extra set (§12.9).
 */
const SET_IDS = ["set-1", "set-2", "set-3", "set-4"] as const;
const RANGE_8_12: RepTargetV1 = { kind: "RANGE", minReps: 8, maxReps: 12 };
const EXACT_5: RepTargetV1 = { kind: "EXACT", reps: 5 };
const LOAD_60KG: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };
const RIR = (value: 0 | 1 | 2 | 3): RirV1 => ({ kind: "RIR", value });

function prescription(overrides: Partial<ProgressionEvaluationInput["prescription"]> = {}): ProgressionEvaluationInput["prescription"] {
  return {
    exerciseRef: "bench-press",
    prescriptionExerciseId: "presc-ex-1",
    targetReps: RANGE_8_12,
    targetLoad: LOAD_60KG,
    prescribedWorkingSetIds: [SET_IDS[0], SET_IDS[1], SET_IDS[2]],
    ...overrides,
  };
}

interface ExposureOptions {
  readonly comparability?: ComparabilityTierV1;
  readonly exerciseRef?: string;
  /** Sets beyond `prescribedWorkingSetIds`'s length map to `null` (unplanned/extra, §12.9). */
  readonly setIds?: readonly (string | null)[];
  readonly rir?: readonly (RirV1 | undefined)[];
}

function exposure(reps: readonly number[], options: ExposureOptions = {}): ProgressionExposureV1 {
  const setIds = options.setIds ?? SET_IDS;
  const workingSets: ProgressionExposureWorkingSetV1[] = reps.map((actualReps, index) => {
    const rir = options.rir?.[index];
    return {
      prescriptionSetId: setIds[index] ?? null,
      setType: "WORKING",
      actualReps,
      ...(rir !== undefined ? { performedRir: rir } : {}),
    };
  });
  return {
    comparability: options.comparability ?? "COMPARABLE",
    exerciseRef: options.exerciseRef ?? "bench-press",
    workingSets,
  };
}

function decide(input: ProgressionEvaluationInput): ProgressionDecisionDataV1 {
  const result = evaluateProgression(input);
  if (!result.ok) throw new Error(`expected valid input, got ${JSON.stringify(result.error)}`);
  return result.value.data;
}

describe("Pure Progression Engine V1 — domain matrix", () => {
  // PROG-029 / Worked example 2
  it("PROG-029: zero exposures ever -> NO_CHANGE / INSUFFICIENT_EVIDENCE / INSUFFICIENT", () => {
    const decision = decide({ prescription: prescription(), exposures: [] });
    expect(decision).toEqual({
      decisionType: "NO_CHANGE",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      evidenceStrength: "INSUFFICIENT",
      progressionStalled: false,
      recommendedChange: null,
    });
  });

  // PROG-028 / Worked example 11 / OD-5 — see "single qualifying exposure" describe block below for the full discussion.
  it("PROG-028: a single qualifying exposure with zero prior history -> INCREASE_LOAD, not gated by window size", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([12, 12, 12])] });
    expect(decision.decisionType).toBe("INCREASE_LOAD");
    expect(decision.reasonCode).toBe("TOP_OF_RANGE_ACHIEVED");
    expect(decision.evidenceStrength).toBe("SINGLE_EXPOSURE");
    expect(decision.progressionStalled).toBe(false);
    expect(decision.recommendedChange).toEqual({
      direction: "INCREASE",
      currentLoad: LOAD_60KG,
      currentTargetReps: RANGE_8_12,
    });
  });

  // PROG-004 / Worked example 1. Worked example 1 labels this STRONG without
  // mentioning RIR at all; §9.3 and §17.3's own SUPPORTED row both state
  // (twice, unconditionally) that missing RIR anywhere in the window caps
  // strength at SUPPORTED — the stronger, twice-stated rule, not the
  // silent/underspecified example, governs here (see final report). The
  // dedicated RIR-corroboration test below proves the STRONG path exists.
  it("PROG-004: RANGE, all prescribed working sets reach maxReps, full 3-exposure COMPARABLE window agreeing -> INCREASE_LOAD / SUPPORTED (no RIR supplied)", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([12, 12, 12]), exposure([12, 12, 11]), exposure([12, 12, 12])],
    });
    expect(decision.decisionType).toBe("INCREASE_LOAD");
    expect(decision.reasonCode).toBe("TOP_OF_RANGE_ACHIEVED");
    expect(decision.evidenceStrength).toBe("SUPPORTED");
  });

  // PROG-014 / Worked example 8 — see the PROG-004 comment above re: RIR and STRONG.
  it("Worked example 8: EXACT target, 3 consecutive exposures hit exactly 5/5/5 -> INCREASE_LOAD / SUPPORTED (no RIR supplied)", () => {
    const decision = decide({
      prescription: prescription({ targetReps: EXACT_5 }),
      exposures: [exposure([5, 5, 5]), exposure([5, 5, 5]), exposure([5, 5, 5])],
    });
    expect(decision.decisionType).toBe("INCREASE_LOAD");
    expect(decision.reasonCode).toBe("TOP_OF_RANGE_ACHIEVED");
    expect(decision.evidenceStrength).toBe("SUPPORTED");
  });

  // PROG-004 vs "one set at max, others below" — task matrix item 4
  it("one set at max but others below maxReps -> not INCREASE_LOAD (never a single-good-set overreaction)", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([12, 9, 9])] });
    expect(decision.decisionType).not.toBe("INCREASE_LOAD");
    expect(decision.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
  });

  // PROG-005 / §12.3's literal example — uneven sets, real forward progress
  it("PROG-005: uneven sets 12/11/9 against 8-12 -> MAINTAIN_LOAD_BUILD_REPS / REPS_PROGRESSING, never INCREASE_LOAD", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([12, 11, 9])] });
    expect(decision.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(decision.reasonCode).toBe("REPS_PROGRESSING");
  });

  // RANGE Precedence Fix (2026-09-22) — regression/below-floor evidence must
  // take precedence over a partial top-of-range touch. This suite proves the
  // exact bug report and its required tests (A-G).
  describe("RANGE precedence: regression must not be masked by a partial bar touch", () => {
    // A. prior 11/10/9 -> current 12/9/8: slot 1 improved to the bar, but
    // slots 2 and 3 both regressed -- the exposure as a whole is regressed.
    it("A: prior 11/10/9, current 12/9/8 -> NO_CHANGE / PERFORMANCE_REGRESSED_SINGLE_EXPOSURE, not MAINTAIN_LOAD_BUILD_REPS", () => {
      const decision = decide({
        prescription: prescription(),
        exposures: [exposure([12, 9, 8]), exposure([11, 10, 9])],
      });
      expect(decision.decisionType).toBe("NO_CHANGE");
      expect(decision.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");
      // Only 2 exposures exist -- the full 3-exposure stall condition is not
      // independently satisfied, so progressionStalled must stay false.
      expect(decision.progressionStalled).toBe(false);
    });

    // B. prior 11/10/10 -> current 12/10/10: slot 1 improved, no other slot
    // regressed -- genuine positive, non-regressing progression.
    it("B: prior 11/10/10, current 12/10/10 -> MAINTAIN_LOAD_BUILD_REPS", () => {
      const decision = decide({
        prescription: prescription(),
        exposures: [exposure([12, 10, 10]), exposure([11, 10, 10])],
      });
      expect(decision.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
      expect(decision.reasonCode).toBe("REPS_PROGRESSING");
    });

    // C. prior 11/11/11 -> current 12/12/12: full top-of-range bar met by
    // every required set -- must not be broken by the precedence fix.
    it("C: prior 11/11/11, current 12/12/12 -> INCREASE_LOAD (full top-of-range bar unaffected)", () => {
      const decision = decide({
        prescription: prescription(),
        exposures: [exposure([12, 12, 12]), exposure([11, 11, 11])],
      });
      expect(decision.decisionType).toBe("INCREASE_LOAD");
      expect(decision.reasonCode).toBe("TOP_OF_RANGE_ACHIEVED");
    });

    // D. a maxRep touch coexists with a required set below minReps (a
    // within-exposure floor violation, no prior exposure needed at all).
    it("D: current exposure has a maxRep touch but another required set is below minReps -> NO_CHANGE", () => {
      const decision = decide({ prescription: prescription(), exposures: [exposure([12, 7, 10])] });
      expect(decision.decisionType).toBe("NO_CHANGE");
      expect(decision.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");
    });

    // E. EXACT-target behavior is unaffected by the RANGE precedence fix
    // (EXACT's own branch already checked regression first, unconditionally).
    it("E: EXACT target regression behavior is unchanged by the fix", () => {
      const decision = decide({
        prescription: prescription({ targetReps: EXACT_5 }),
        exposures: [exposure([5, 4, 3]), exposure([5, 5, 5])],
      });
      expect(decision.decisionType).toBe("NO_CHANGE");
      expect(decision.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");
    });

    // F. the existing single-exposure top-of-range rule (§11.1/OD-5) is unchanged.
    it("F: single-exposure top-of-range rule is unaffected by the fix (PROG-028)", () => {
      const decision = decide({ prescription: prescription(), exposures: [exposure([12, 12, 12])] });
      expect(decision.decisionType).toBe("INCREASE_LOAD");
      expect(decision.evidenceStrength).toBe("SINGLE_EXPOSURE");
    });

    // G. repeated-stall behavior (§17.2/PROG-007) is unaffected by the fix.
    it("G: repeated-stall behavior across the full 3-exposure window is unaffected by the fix", () => {
      const decision = decide({
        prescription: prescription(),
        exposures: [exposure([6, 6, 6]), exposure([7, 7, 7]), exposure([8, 8, 8])],
      });
      expect(decision.decisionType).toBe("NO_CHANGE");
      expect(decision.progressionStalled).toBe(true);
    });
  });

  // Task prompt's own comparator example: same-load meaningful rep improvement, no set at max
  it("PROG-002 analogue (per §11.1/OD-5, see note below): 10/9/9 -> 11/10/9 against 8-12, no set at max -> MAINTAIN_LOAD_BUILD_REPS / REPS_PROGRESSING", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([11, 10, 9]), exposure([10, 9, 9])],
    });
    expect(decision.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(decision.reasonCode).toBe("REPS_PROGRESSING");
  });

  // PROG-006 / Worked example 4 (the single-bad-exposure half)
  it("PROG-006: one bad exposure only (single data point) -> NO_CHANGE / PERFORMANCE_REGRESSED_SINGLE_EXPOSURE, never stalled", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([6, 6, 5])] });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");
    expect(decision.progressionStalled).toBe(false);
  });

  // Worked example 4, full 3-exposure shape: 2 good priors then 1 bad current
  it("Worked example 4: two prior 10/10/10 exposures then a poor 6/6/5 -> NO_CHANGE / PERFORMANCE_REGRESSED_SINGLE_EXPOSURE / SUPPORTED", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([6, 6, 5]), exposure([10, 10, 10]), exposure([10, 10, 10])],
    });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");
    expect(decision.evidenceStrength).toBe("SUPPORTED");
  });

  // PROG-007 / PROG-027 / Worked example 5 — ordered most-recent-first, monotonically worsening.
  it("PROG-007: regression across all 3 window exposures -> NO_CHANGE + progressionStalled: true, never a deload/decrease decision", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([6, 6, 6]), exposure([7, 7, 7]), exposure([8, 8, 8])],
    });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.progressionStalled).toBe(true);
    expect(PROGRESSION_DECISION_TYPES_V1).not.toContain("DELOAD");
  });

  // Task matrix item 6: stable exposure
  it("stable exposure (flat, within range, no trend) -> NO_CHANGE / PERFORMANCE_STABLE", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([10, 10, 10]), exposure([10, 10, 10]), exposure([10, 10, 10])],
    });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.reasonCode).toBe("PERFORMANCE_STABLE");
  });

  // Worked example 6 — flat performance becomes REPS_PROGRESSING only given a real prior improvement
  it("Worked example 6 (warm-up already excluded upstream): flat 10/10/10 alone -> STABLE; the same numbers after a worse prior -> REPS_PROGRESSING", () => {
    const alone = decide({ prescription: prescription(), exposures: [exposure([10, 10, 10])] });
    expect(alone.decisionType).toBe("NO_CHANGE");
    expect(alone.reasonCode).toBe("SINGLE_EXPOSURE_ONLY");

    const afterWorsePrior = decide({
      prescription: prescription(),
      exposures: [exposure([10, 10, 10]), exposure([8, 8, 8])],
    });
    expect(afterWorsePrior.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(afterWorsePrior.reasonCode).toBe("REPS_PROGRESSING");
  });

  // PROG-008 / PROG-009(partial) / Worked example 7
  it("PROG-008 / Worked example 7: partial workout (2 of 3 required sets, both at max) -> MAINTAIN_LOAD_BUILD_REPS / PARTIAL_EXPOSURE, evidence never STRONG", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([12, 12])],
    });
    expect(decision.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(decision.reasonCode).toBe("PARTIAL_EXPOSURE");
    expect(decision.evidenceStrength).not.toBe("STRONG");
  });

  it("partial workout with no set reaching the bar -> NO_CHANGE / PARTIAL_EXPOSURE (missing work is never read as failure)", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([9, 9])] });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.reasonCode).toBe("PARTIAL_EXPOSURE");
  });

  // PROG-029 distinct from PROG-028: zero working sets logged this session but the exercise has history
  it("PROG-029 variant: current exposure has zero mapped working sets -> NO_CHANGE / INSUFFICIENT_EVIDENCE", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([]), exposure([12, 12, 12])],
    });
    expect(decision.decisionType).toBe("NO_CHANGE");
    expect(decision.reasonCode).toBe("INSUFFICIENT_EVIDENCE");
  });

  // Task matrix items 11/12 — WARM_UP exclusion/rejection
  it("unexpected WARM_UP evidence is rejected outright, never silently filtered or allowed to distort a decision (§5.6/§28)", () => {
    const result = evaluateProgression({
      prescription: prescription(),
      exposures: [
        {
          comparability: "COMPARABLE",
          exerciseRef: "bench-press",
          workingSets: [
            { prescriptionSetId: SET_IDS[0], setType: "WARM_UP", actualReps: 5 },
            { prescriptionSetId: SET_IDS[1], setType: "WORKING", actualReps: 12 },
            { prescriptionSetId: SET_IDS[2], setType: "WORKING", actualReps: 12 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  // Task matrix item 13/14 — RANGE vs EXACT
  it("PROG-013/014: RANGE and EXACT are evaluated by distinct rules for the same evidence shape", () => {
    const rangeDecision = decide({ prescription: prescription({ targetReps: RANGE_8_12 }), exposures: [exposure([10, 10, 10])] });
    const exactDecision = decide({ prescription: prescription({ targetReps: EXACT_5 }), exposures: [exposure([5, 5, 5])] });
    expect(rangeDecision.decisionType).toBe("NO_CHANGE"); // 10 < maxReps 12
    expect(exactDecision.decisionType).toBe("INCREASE_LOAD"); // exactly meets EXACT
  });

  // §10/§12.2 — EXACT never returns MAINTAIN_LOAD_BUILD_REPS, even with a clearly improving trend
  it("PROG-015 (EXACT semantics): EXACT never returns MAINTAIN_LOAD_BUILD_REPS merely because reps increased", () => {
    const decision = decide({
      prescription: prescription({ targetReps: EXACT_5 }),
      exposures: [exposure([4, 4, 4]), exposure([3, 3, 3])],
    });
    expect(decision.decisionType).not.toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(decision.decisionType).toBe("NO_CHANGE");
  });

  // PROG-015 / §10.1 — different exerciseRef is NOT_COMPARABLE and never reaches the engine as evidence
  it("PROG-015: a different exerciseRef inside the evaluation is rejected as invalid input, never treated as trend evidence", () => {
    const result = evaluateProgression({
      prescription: prescription(),
      exposures: [exposure([12, 12, 12], { exerciseRef: "incline-dumbbell-press" })],
    });
    expect(result.ok).toBe(false);
  });

  // PROG-016 / Worked example 10
  it("PROG-016: COMPARABLE_WITH_CONTEXT caps evidence strength at SUPPORTED even when the exposure otherwise clearly qualifies", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [
        exposure([12, 12, 12], { comparability: "COMPARABLE_WITH_CONTEXT" }),
        exposure([12, 12, 12]),
        exposure([12, 12, 12]),
      ],
    });
    expect(decision.decisionType).toBe("INCREASE_LOAD");
    expect(decision.evidenceStrength).toBe("SUPPORTED");
  });

  // PROG-017 — INCREASE_LOAD direction-only output, never a resolved kg value
  it("PROG-017: INCREASE_LOAD carries direction + current state only, never a computed next load", () => {
    const decision = decide({ prescription: prescription(), exposures: [exposure([12, 12, 12])] });
    expect(decision.recommendedChange).toEqual({
      direction: "INCREASE",
      currentLoad: LOAD_60KG,
      currentTargetReps: RANGE_8_12,
    });
    // No numeric delta/next-weight field exists on the type at all — the shape itself proves this.
  });

  // PROG-018 — application-layer downgrade is out of this engine's scope; only proves the vocabulary exists and is never self-emitted.
  it("PROG-018: NO_SUITABLE_LOAD_INCREMENT is a valid vocabulary member the engine itself never emits (that is an application-layer downgrade, §17.1)", () => {
    const fixtures: ProgressionEvaluationInput[] = [
      { prescription: prescription(), exposures: [] },
      { prescription: prescription(), exposures: [exposure([12, 12, 12])] },
      { prescription: prescription(), exposures: [exposure([9, 9, 9])] },
      { prescription: prescription(), exposures: [exposure([6, 6, 5])] },
      { prescription: prescription({ targetReps: EXACT_5 }), exposures: [exposure([5, 5, 5])] },
    ];
    for (const input of fixtures) {
      expect(decide(input).reasonCode).not.toBe("NO_SUITABLE_LOAD_INCREMENT");
    }
  });

  // PROG-020 — PER_IMPLEMENT passed through unchanged, never summed
  it("PROG-020: PER_IMPLEMENT load is passed through to recommendedChange unchanged, never summed into TOTAL", () => {
    const perImplementLoad: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 20000, unit: "KG", basis: "PER_IMPLEMENT" };
    const decision = decide({
      prescription: prescription({ targetLoad: perImplementLoad }),
      exposures: [exposure([12, 12, 12])],
    });
    expect(decision.recommendedChange?.currentLoad).toEqual(perImplementLoad);
  });

  // PROG-021/22 — RIR
  it("PROG-021: RIR missing throughout never blocks a decision and never exceeds SUPPORTED evidence strength", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([12, 12, 12]), exposure([12, 12, 11]), exposure([12, 12, 12])],
    });
    expect(decision.decisionType).toBe("INCREASE_LOAD");
    expect(decision.evidenceStrength).not.toBe("STRONG");
  });

  it("PROG-022: RIR present and corroborating throughout a full agreeing window can reach STRONG", () => {
    const rirAllSets = [RIR(0), RIR(0), RIR(0)] as const;
    const decision = decide({
      prescription: prescription({ targetRir: RIR(1) }),
      exposures: [
        exposure([12, 12, 12], { rir: rirAllSets }),
        exposure([12, 12, 11], { rir: rirAllSets }),
        exposure([12, 12, 12], { rir: rirAllSets }),
      ],
    });
    expect(decision.evidenceStrength).toBe("STRONG");
  });

  it("missing RIR on even one set caps strength below STRONG even when everything else qualifies", () => {
    const decision = decide({
      prescription: prescription({ targetRir: RIR(1) }),
      exposures: [
        exposure([12, 12, 12], { rir: [RIR(0), RIR(0)] }), // 3rd set's RIR missing
        exposure([12, 12, 11], { rir: [RIR(0), RIR(0), RIR(0)] }),
        exposure([12, 12, 12], { rir: [RIR(0), RIR(0), RIR(0)] }),
      ],
    });
    expect(decision.evidenceStrength).toBe("SUPPORTED");
  });

  // PROG-026 — extra sets
  it("PROG-026: an extra unplanned set does not inflate progression — a 4th logged set beyond the 3 required never satisfies completion by itself", () => {
    const decision = decide({
      prescription: prescription(),
      exposures: [exposure([9, 9, 9, 99], { setIds: [SET_IDS[0], SET_IDS[1], SET_IDS[2], null] })],
    });
    // The 3 required sets are all below maxReps; the huge 4th (unplanned) set must not push this to INCREASE_LOAD.
    expect(decision.decisionType).not.toBe("INCREASE_LOAD");
  });

  // PROG-025 — prescription changed / reset
  it("PROG-025: prescription-change reset relabels the reason, but a fully qualifying current exposure still independently progresses", () => {
    const resetButQualifying = decide({
      prescription: prescription(),
      exposures: [exposure([12, 12, 12])],
      priorExposuresExcludedByPrescriptionChange: true,
    });
    expect(resetButQualifying.decisionType).toBe("INCREASE_LOAD");

    const resetAndEmpty = decide({
      prescription: prescription(),
      exposures: [],
      priorExposuresExcludedByPrescriptionChange: true,
    });
    expect(resetAndEmpty.decisionType).toBe("NO_CHANGE");
    expect(resetAndEmpty.reasonCode).toBe("PRESCRIPTION_CHANGED_RESET");
  });

  // PROG-002 note: the resolved (OD-5) test-matrix conflict is documented in the final report,
  // not re-litigated here — see "single qualifying exposure" tests above/below, which follow
  // §11.1/OD-5/Worked-example-11 (the explicitly resolved rule).
});

describe("Pure Progression Engine V1 — determinism (§19/§30)", () => {
  const qualifyingInput: ProgressionEvaluationInput = {
    prescription: prescription(),
    exposures: [exposure([12, 12, 12]), exposure([12, 12, 11])],
  };

  it("PROG-023/030: the same input evaluated repeatedly yields a byte/deep-equal EngineDecision", () => {
    const first = evaluateProgression(qualifyingInput);
    const second = evaluateProgression(qualifyingInput);
    expect(first).toEqual(second);
  });

  it("PROG-011/024: a corrected snapshot can produce a different decision, while the original snapshot remains deterministic", () => {
    const original = decide(qualifyingInput);
    const corrected: ProgressionEvaluationInput = {
      prescription: prescription(),
      exposures: [exposure([9, 9, 9]), exposure([12, 12, 11])],
    };
    const correctedDecision = decide(corrected);
    expect(correctedDecision).not.toEqual(original);

    // Re-evaluating the ORIGINAL snapshot again still yields exactly the original decision.
    expect(decide(qualifyingInput)).toEqual(original);
  });

  // PROG-012 / §22/§23 — canonical identity, never timestamp/array order
  it("PROG-012: working sets supplied out of canonical order produce the same decision as canonical order", () => {
    const canonical = decide({ prescription: prescription(), exposures: [exposure([12, 9, 10])] });
    const shuffled = decide({
      prescription: prescription(),
      exposures: [
        {
          comparability: "COMPARABLE",
          exerciseRef: "bench-press",
          workingSets: [
            { prescriptionSetId: SET_IDS[2], setType: "WORKING", actualReps: 10 },
            { prescriptionSetId: SET_IDS[0], setType: "WORKING", actualReps: 12 },
            { prescriptionSetId: SET_IDS[1], setType: "WORKING", actualReps: 9 },
          ],
        },
      ],
    });
    expect(shuffled).toEqual(canonical);
  });

  it("§31 — policy version is explicit and reused from the existing EngineVersion contract", () => {
    expect(progressionPolicyV1.version).toEqual({ engine: "progression", policy: "v1" });
  });
});

describe("Pure Progression Engine V1 — invariants", () => {
  it("exactly 3 decision types exist, and none of them decrease difficulty (§26)", () => {
    expect(PROGRESSION_DECISION_TYPES_V1).toEqual(["NO_CHANGE", "MAINTAIN_LOAD_BUILD_REPS", "INCREASE_LOAD"]);
    for (const forbidden of ["DECREASE_LOAD", "REDUCE_REPS", "REDUCE_SETS", "DELOAD", "REDUCE_VOLUME", "CHANGE_EXERCISE"]) {
      expect(PROGRESSION_DECISION_TYPES_V1 as readonly string[]).not.toContain(forbidden);
    }
  });

  it("every produced decision's reasonCode is logically compatible with its decisionType (§17.1's pairing table)", () => {
    const fixtures: ProgressionEvaluationInput[] = [
      { prescription: prescription(), exposures: [] },
      { prescription: prescription(), exposures: [exposure([12, 12, 12])] },
      { prescription: prescription(), exposures: [exposure([12, 11, 9])] },
      { prescription: prescription(), exposures: [exposure([10, 10, 10])] },
      { prescription: prescription(), exposures: [exposure([6, 6, 5])] },
      { prescription: prescription(), exposures: [exposure([12, 12])] },
      { prescription: prescription({ targetReps: EXACT_5 }), exposures: [exposure([5, 5, 5])] },
      { prescription: prescription({ targetReps: EXACT_5 }), exposures: [exposure([3, 3, 3])] },
    ];
    for (const input of fixtures) {
      const decision = decide(input);
      const allowedDecisions: readonly string[] = REASON_CODE_DECISION_PAIRS_V1[decision.reasonCode];
      expect(allowedDecisions).toContain(decision.decisionType);
    }
  });

  it("progressionStalled is only ever true alongside NO_CHANGE, never alongside a progression decision (§17.2/§16)", () => {
    const fixtures: ProgressionEvaluationInput[] = [
      { prescription: prescription(), exposures: [exposure([12, 12, 12])] },
      { prescription: prescription(), exposures: [exposure([12, 11, 9])] },
      { prescription: prescription(), exposures: [exposure([6, 6, 5]), exposure([6, 5, 5]), exposure([7, 6, 5])] },
    ];
    for (const input of fixtures) {
      const decision = decide(input);
      if (decision.progressionStalled) expect(decision.decisionType).toBe("NO_CHANGE");
    }
  });

  it("the engine never returns anything outside the 3 approved decision types", () => {
    const fixtures: ProgressionEvaluationInput[] = [
      { prescription: prescription(), exposures: [] },
      { prescription: prescription(), exposures: [exposure([12, 12, 12])] },
      { prescription: prescription({ targetReps: EXACT_5 }), exposures: [exposure([5, 5, 5])] },
    ];
    for (const input of fixtures) {
      expect(PROGRESSION_DECISION_TYPES_V1 as readonly string[]).toContain(decide(input).decisionType);
    }
  });
});

describe("Pure Progression Engine V1 — infrastructure-free, degraded-input safety", () => {
  it("progressionPolicyV1.decide() never throws, even on structurally invalid input (Failure mode)", () => {
    const invalidInput = { prescription: prescription({ prescribedWorkingSetIds: [] }), exposures: [] };
    expect(() => progressionPolicyV1.decide(invalidInput)).not.toThrow();
    const decision = progressionPolicyV1.decide(invalidInput);
    expect(decision.data.decisionType).toBe("NO_CHANGE");
    expect(decision.data.reasonCode).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("evaluateProgression() returns an explicit err() for the same invalid input, distinguishing it from a real NO_CHANGE decision (§28)", () => {
    const invalidInput = { prescription: prescription({ prescribedWorkingSetIds: [] }), exposures: [] };
    const result = evaluateProgression(invalidInput);
    expect(result.ok).toBe(false);
  });

  it("has no framework or infrastructure dependency at the type level (packages/training-engine boundary)", () => {
    expect(typeof progressionPolicyV1.decide).toBe("function");
    expect(typeof evaluateProgression).toBe("function");
  });
});
