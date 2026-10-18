import { err, ok, type Result } from "@vostivo/domain";
import type { EngineDecision, EnginePolicy } from "../decision.js";
import type { EquipmentAdaptationDecisionDataV1, EquipmentReplacementV1, PreservedPrescriptionV1, SessionExerciseSlotV1, UnresolvedExerciseV1 } from "./decision-data.js";
import type { EquipmentAdaptationExerciseV1, EquipmentAdaptationInputV1, EquipmentIdV1, SubstituteCandidateV1 } from "./input.js";
import { validateEquipmentAdaptationInput, type EquipmentAdaptationInputValidationErrorV1 } from "./validate-input.js";
import { PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD, type EquipmentAdaptationReviewReasonV1 } from "./vocabulary.js";

/**
 * Pure Temporary Equipment / Gym Adaptation Policy V1
 * (docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md). Deterministic and
 * side-effect free: no clock, DB, network, randomness or id generation, no
 * mode branch, and the input is never mutated.
 *
 * PRESERVE THE EXERCISE ROLE, CHANGE THE TOOL — SMALLEST NECESSARY CHANGE:
 * only an exercise whose required equipment is unavailable THIS SESSION is
 * touched; it is replaced in place by its unique best CURATED
 * ROLE_EQUIVALENT candidate with a preserved working prescription and a
 * RESET load. Everything else is untouched — no whole-workout regeneration,
 * no reordering. If ANY affected exercise cannot be resolved safely, the
 * whole decision is REVIEW_REQUIRED (NO SILENT PARTIAL APPLICATION).
 */

function isPerformable(requiredEquipmentIds: readonly EquipmentIdV1[], available: ReadonlySet<EquipmentIdV1>): boolean {
  return requiredEquipmentIds.every((id) => available.has(id));
}

function byAuthoredOrder(a: EquipmentAdaptationExerciseV1, b: EquipmentAdaptationExerciseV1): number {
  return a.order - b.order;
}

type Selection = { readonly kind: "SELECTED"; readonly candidate: SubstituteCandidateV1 } | { readonly kind: "UNRESOLVED"; readonly reasonCode: EquipmentAdaptationReviewReasonV1 };

/**
 * Fixed, documented filter order for ONE unavailable exercise — each step
 * narrows the curated list; the first step that empties it names the reason:
 *   1. LOCKED                                   -> LOCKED_EXERCISE_UNAVAILABLE
 *   2. no curated candidate at all              -> NO_CURATED_SUBSTITUTE
 *   3. drop: itself, athlete-blocked, needing unavailable equipment
 *                                               -> NO_AVAILABLE_SUBSTITUTE
 *   4. keep ROLE_EQUIVALENT only                -> NO_EQUIVALENT_SUBSTITUTE
 *   5. keep PRESERVE_WORKING_PRESCRIPTION only  -> UNSUPPORTED_PRESCRIPTION_COMPATIBILITY
 *   6. drop identities already in the session   -> SUBSTITUTE_CONFLICT
 *   7. best (lowest) priority must be unique    -> AMBIGUOUS_SUBSTITUTION
 */
function selectSubstitute(
  exercise: EquipmentAdaptationExerciseV1,
  available: ReadonlySet<EquipmentIdV1>,
  blocked: ReadonlySet<string>,
  takenExerciseIds: ReadonlySet<string>,
): Selection {
  if (exercise.substitutionPolicy === "LOCKED") return { kind: "UNRESOLVED", reasonCode: "LOCKED_EXERCISE_UNAVAILABLE" };
  if (exercise.candidates.length === 0) return { kind: "UNRESOLVED", reasonCode: "NO_CURATED_SUBSTITUTE" };

  const usable = exercise.candidates.filter(
    (c) => c.substituteExerciseId !== exercise.exerciseId && !blocked.has(c.substituteExerciseId) && isPerformable(c.requiredEquipmentIds, available),
  );
  if (usable.length === 0) return { kind: "UNRESOLVED", reasonCode: "NO_AVAILABLE_SUBSTITUTE" };

  const equivalent = usable.filter((c) => c.compatibilityTier === "ROLE_EQUIVALENT");
  if (equivalent.length === 0) return { kind: "UNRESOLVED", reasonCode: "NO_EQUIVALENT_SUBSTITUTE" };

  const preserving = equivalent.filter((c) => c.prescriptionCompatibility === "PRESERVE_WORKING_PRESCRIPTION");
  if (preserving.length === 0) return { kind: "UNRESOLVED", reasonCode: "UNSUPPORTED_PRESCRIPTION_COMPATIBILITY" };

  // Never two slots with one exercise identity: that would collapse two programmed roles.
  const unconflicted = preserving.filter((c) => !takenExerciseIds.has(c.substituteExerciseId));
  if (unconflicted.length === 0) return { kind: "UNRESOLVED", reasonCode: "SUBSTITUTE_CONFLICT" };

  const best = Math.min(...unconflicted.map((c) => c.substitutionPriority));
  const winners = unconflicted.filter((c) => c.substitutionPriority === best);
  if (winners.length !== 1) return { kind: "UNRESOLVED", reasonCode: "AMBIGUOUS_SUBSTITUTION" };
  return { kind: "SELECTED", candidate: winners[0]! };
}

/** Working structure preserved, load NEVER carried (working or warm-up) — resolved later for the substitute's own identity. */
function preservePrescription(exercise: EquipmentAdaptationExerciseV1): PreservedPrescriptionV1 {
  const sets = [...exercise.sets]
    .sort((a, b) => a.order - b.order)
    .map((set) => ({ plannedSetId: set.plannedSetId, order: set.order, setType: set.setType, targetReps: set.targetReps, restSeconds: set.restSeconds }));
  return {
    policy: PRESERVE_WORKING_PRESCRIPTION_RESET_LOAD,
    workingSetCount: sets.filter((s) => s.setType === "WORKING").length,
    sets,
    availableTime: exercise.availableTime === null ? null : { priorityTier: exercise.availableTime.priorityTier, minimumWorkingSets: exercise.availableTime.minimumWorkingSets },
    workingLoadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
    warmUpLoadResolution: sets.some((s) => s.setType === "WARM_UP") ? "RESOLVE_FOR_SUBSTITUTE_EXERCISE" : null,
  };
}

function decideCore(input: EquipmentAdaptationInputV1): EquipmentAdaptationDecisionDataV1 {
  const available = new Set(input.availableEquipmentIds);
  const blocked = new Set(input.athleteBlockedExerciseIds);
  const exercises = [...input.exercises].sort(byAuthoredOrder);

  const unavailable = exercises.filter((e) => !isPerformable(e.requiredEquipmentIds, available));
  if (unavailable.length === 0) return { resultKind: "NO_CHANGE", reasonCode: "ALL_EQUIPMENT_AVAILABLE" };

  // Sequential in authored order; each selected substitute is taken for later slots.
  const taken = new Set(exercises.map((e) => e.exerciseId));
  const selected = new Map<string, SubstituteCandidateV1>();
  const unresolved: UnresolvedExerciseV1[] = [];
  for (const exercise of unavailable) {
    const selection = selectSubstitute(exercise, available, blocked, taken);
    if (selection.kind === "UNRESOLVED") {
      unresolved.push({ plannedExerciseId: exercise.plannedExerciseId, authoredExerciseId: exercise.exerciseId, reasonCode: selection.reasonCode });
      continue;
    }
    selected.set(exercise.plannedExerciseId, selection.candidate);
    taken.add(selection.candidate.substituteExerciseId);
  }

  if (unresolved.length > 0) {
    // NO SILENT PARTIAL APPLICATION: no replacement is returned at all.
    return { resultKind: "REVIEW_REQUIRED", reasonCode: unresolved[0]!.reasonCode, unresolved, unavailablePlannedExerciseIds: unavailable.map((e) => e.plannedExerciseId) };
  }

  const replacements: EquipmentReplacementV1[] = unavailable.map((exercise) => ({
    plannedExerciseId: exercise.plannedExerciseId,
    authoredExerciseId: exercise.exerciseId,
    substituteExerciseId: selected.get(exercise.plannedExerciseId)!.substituteExerciseId,
    order: exercise.order,
    reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
    prescription: preservePrescription(exercise),
  }));
  const session: SessionExerciseSlotV1[] = exercises.map((exercise) => {
    const substitute = selected.get(exercise.plannedExerciseId);
    return {
      plannedExerciseId: exercise.plannedExerciseId,
      order: exercise.order,
      authoredExerciseId: exercise.exerciseId,
      effectiveExerciseId: substitute?.substituteExerciseId ?? exercise.exerciseId,
      substituted: substitute !== undefined,
    };
  });
  return { resultKind: "ADJUST_SESSION", reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE", replacements, session };
}

const REASON_DESCRIPTIONS_V1: Readonly<Record<EquipmentAdaptationDecisionDataV1["reasonCode"], string>> = {
  ALL_EQUIPMENT_AVAILABLE: "Every planned exercise can be performed with today's equipment.",
  TEMPORARY_EQUIPMENT_UNAVAILABLE: "Each unavailable exercise is replaced in place by its curated role-equivalent substitute; the working prescription is kept and the load is reset.",
  LOCKED_EXERCISE_UNAVAILABLE: "An unavailable exercise is locked by the program and must not be substituted automatically.",
  NO_CURATED_SUBSTITUTE: "An unavailable exercise has no curated substitute.",
  NO_AVAILABLE_SUBSTITUTE: "No curated substitute is usable with today's equipment and the athlete's blocks.",
  NO_EQUIVALENT_SUBSTITUTE: "Only role-compatible (not role-equivalent) substitutes are available.",
  UNSUPPORTED_PRESCRIPTION_COMPATIBILITY: "No role-equivalent substitute can keep the working prescription.",
  SUBSTITUTE_CONFLICT: "The only substitute is already used elsewhere in the session.",
  AMBIGUOUS_SUBSTITUTION: "Two substitutes share the best curated priority.",
};

/** The reused `EnginePolicy` contract. `decide()` assumes structurally valid input — prefer `evaluateEquipmentAdaptation()`. */
export const equipmentAdaptationPolicyV1: EnginePolicy<EquipmentAdaptationInputV1, "equipment-adaptation", EquipmentAdaptationDecisionDataV1> = {
  version: { engine: "equipment-adaptation", policy: "v1" },
  decide(input) {
    const data = decideCore(input);
    return { kind: "equipment-adaptation", version: equipmentAdaptationPolicyV1.version, data, reason: REASON_DESCRIPTIONS_V1[data.reasonCode] };
  },
};

/** Recommended entry point: validates first, so malformed input is a typed `err`, never silently a decision. */
export function evaluateEquipmentAdaptation(
  input: EquipmentAdaptationInputV1,
): Result<EngineDecision<"equipment-adaptation", EquipmentAdaptationDecisionDataV1>, EquipmentAdaptationInputValidationErrorV1> {
  const validation = validateEquipmentAdaptationInput(input);
  if (!validation.ok) return err(validation.error);
  return ok(equipmentAdaptationPolicyV1.decide(validation.value));
}
