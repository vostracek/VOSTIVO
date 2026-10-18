import { createHash } from "node:crypto";
import {
  EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
  type EquipmentAdaptationPreviewReplacementV1,
  type EquipmentAdaptationPreviewResponseV1,
  type EquipmentAdaptationPreviewUnresolvedV1,
} from "@vostivo/contracts";
import { exerciseEquipmentCatalogV1, type ExerciseEquipmentCatalogLookupV1, type RepTargetV1, type SetType } from "@vostivo/domain";
import { canonicalStringify } from "@vostivo/progression-application";
import {
  EQUIPMENT_ADAPTATION_POLICY_VERSION_V1,
  catalogEquipmentFacts,
  evaluateEquipmentAdaptation,
  type EquipmentAdaptationDecisionDataV1,
  type EquipmentAdaptationExerciseV1,
  type EquipmentAdaptationInputV1,
  type PriorityTierV1,
} from "@vostivo/training-engine";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice B: the PURE half of the
 * read-only server preview. Server-owned rows + the explicit session
 * inventory in, the preview contract out. Requirements and curated
 * candidates come ONLY from the canonical catalog (`catalogEquipmentFacts`);
 * the decision ONLY from the unchanged `equipment-adaptation/v1` policy.
 * No DB, no clock, no randomness.
 */

/** Bumped only if this fingerprint's own input shape changes. */
const PREVIEW_FINGERPRINT_SCHEMA = "equipment-adaptation-preview-fingerprint/v1";

export interface EquipmentPreviewSetRow {
  readonly plannedSetId: string;
  readonly order: number;
  readonly setType: SetType;
  readonly targetReps: RepTargetV1 | null;
  readonly restSeconds: number | null;
}

export interface EquipmentPreviewExerciseRow {
  readonly plannedExerciseId: string;
  /** `null` = no catalog identity (freeform exercise). */
  readonly exerciseRef: string | null;
  /** The authored label (`PlannedExercise.displayName`) — presentation only, never matched against. */
  readonly displayName: string;
  readonly order: number;
  readonly priorityTier: PriorityTierV1 | null;
  readonly minimumWorkingSets: number | null;
  readonly sets: readonly EquipmentPreviewSetRow[];
}

/** Everything the preview is derived from — all server-owned except `availableEquipmentIds` (already canonical). */
export interface EquipmentPreviewSource {
  readonly athleteProfileId: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly plannedWorkoutId: string;
  readonly workoutName: string;
  readonly athleteLocalDate: string;
  /** The EFFECTIVE date that made this today's workout (authored date or the missed-workout overlay). */
  readonly effectiveScheduledDate: string;
  /** The canonical occurrence state used for pre-start eligibility (`null` = no canonical session). */
  readonly canonicalSessionStatus: null;
  readonly exercises: readonly EquipmentPreviewExerciseRow[];
  /** Canonical (sorted, deduplicated, catalog-validated) session inventory. */
  readonly availableEquipmentIds: readonly string[];
}

export type EquipmentInventoryResult = { readonly ok: true; readonly availableEquipmentIds: readonly string[] } | { readonly ok: false; readonly unknownEquipmentIds: readonly string[] };

/**
 * The request's inventory, canonicalized: every id must be a canonical
 * catalog equipment id (unknown ids are rejected, never ignored);
 * duplicates collapse; order never matters (sorted). `[]` is valid.
 */
export function canonicalizeSessionInventory(ids: readonly string[], catalog: ExerciseEquipmentCatalogLookupV1 = exerciseEquipmentCatalogV1): EquipmentInventoryResult {
  const unique = [...new Set(ids)].sort();
  const unknown = unique.filter((id) => catalog.getEquipmentDefinition(id) === null);
  return unknown.length > 0 ? { ok: false, unknownEquipmentIds: unknown } : { ok: true, availableEquipmentIds: unique };
}

/**
 * No persisted lock or athlete exercise block exists yet (inspected
 * 2026-10-10): every slot is ALLOW_TEMPORARY and the blocked set is empty —
 * both server-owned, never client-supplied. Future program/coach locks and
 * athlete preferences replace these two constants.
 */
const SUBSTITUTION_POLICY = "ALLOW_TEMPORARY" as const;
const ATHLETE_BLOCKED_EXERCISE_IDS: readonly string[] = [];

type EngineInputs = { readonly kind: "SUPPORTED"; readonly input: EquipmentAdaptationInputV1 } | { readonly kind: "UNSUPPORTED"; readonly unsupported: readonly EquipmentPreviewExerciseRow[] };

function byOrder<T extends { readonly order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

/** UNKNOWN EXERCISE IDENTITY FAILS CLOSED: any null/unknown ref -> no engine run at all (never "no equipment needed", never name-matched). */
export function buildEquipmentAdaptationInput(source: EquipmentPreviewSource, catalog: ExerciseEquipmentCatalogLookupV1 = exerciseEquipmentCatalogV1): EngineInputs {
  const exercises = [...source.exercises].sort(byOrder);
  const unsupported: EquipmentPreviewExerciseRow[] = [];
  const engineExercises: EquipmentAdaptationExerciseV1[] = [];
  for (const exercise of exercises) {
    const facts = catalogEquipmentFacts(catalog, exercise.exerciseRef);
    if (facts.kind === "UNSUPPORTED_EXERCISE_IDENTITY") {
      unsupported.push(exercise);
      continue;
    }
    engineExercises.push({
      plannedExerciseId: exercise.plannedExerciseId,
      exerciseId: facts.exerciseId,
      order: exercise.order,
      requiredEquipmentIds: facts.requiredEquipmentIds,
      substitutionPolicy: SUBSTITUTION_POLICY,
      // Load is deliberately not passed: the policy never carries it (PRESERVE_..._RESET_LOAD).
      sets: [...exercise.sets].sort(byOrder).map((set) => ({ ...set, targetLoad: null })),
      availableTime: exercise.priorityTier !== null && exercise.minimumWorkingSets !== null ? { priorityTier: exercise.priorityTier, minimumWorkingSets: exercise.minimumWorkingSets } : null,
      candidates: facts.candidates,
    });
  }
  if (unsupported.length > 0) return { kind: "UNSUPPORTED", unsupported };
  return { kind: "SUPPORTED", input: { exercises: engineExercises, availableEquipmentIds: source.availableEquipmentIds, athleteBlockedExerciseIds: ATHLETE_BLOCKED_EXERCISE_IDS } };
}

export type EquipmentPreviewOutcome =
  | { readonly ok: true; readonly preview: EquipmentAdaptationPreviewResponseV1 }
  /** The authored prescription is structurally invalid for the policy (e.g. an Available-Time minimum above the working set count). */
  | { readonly ok: false; readonly code: "EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION" };

type SemanticDecision = EquipmentAdaptationDecisionDataV1 | { readonly resultKind: "REVIEW_REQUIRED"; readonly reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY"; readonly unsupportedPlannedExerciseIds: readonly string[] };

/**
 * Deterministic stale-input guard for Slice C: covers every semantic fact
 * that could change the application result — never display labels, request
 * array order, the clock instant or random ids. Not an auth token.
 */
export function computeEquipmentPreviewFingerprint(source: EquipmentPreviewSource, catalogVersion: string, decision: SemanticDecision): string {
  const canonical = canonicalStringify({
    fingerprintSchema: PREVIEW_FINGERPRINT_SCHEMA,
    previewSchema: EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
    policyVersion: EQUIPMENT_ADAPTATION_POLICY_VERSION_V1,
    catalogVersion,
    athleteProfileId: source.athleteProfileId,
    programVersionId: source.programVersionId,
    trainingBlockId: source.trainingBlockId,
    plannedWorkoutId: source.plannedWorkoutId,
    athleteLocalDate: source.athleteLocalDate,
    effectiveScheduledDate: source.effectiveScheduledDate,
    canonicalSessionStatus: source.canonicalSessionStatus,
    exercises: [...source.exercises].sort(byOrder).map((exercise) => ({
      plannedExerciseId: exercise.plannedExerciseId,
      exerciseRef: exercise.exerciseRef,
      order: exercise.order,
      substitutionPolicy: SUBSTITUTION_POLICY,
      priorityTier: exercise.priorityTier,
      minimumWorkingSets: exercise.minimumWorkingSets,
      sets: [...exercise.sets].sort(byOrder),
    })),
    athleteBlockedExerciseIds: ATHLETE_BLOCKED_EXERCISE_IDS,
    availableEquipmentIds: [...source.availableEquipmentIds].sort(),
    decision,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The whole preview: identity resolution -> unchanged `equipment-adaptation/v1` -> structured contract. */
export function computeEquipmentAdaptationPreview(source: EquipmentPreviewSource, catalog: ExerciseEquipmentCatalogLookupV1 = exerciseEquipmentCatalogV1): EquipmentPreviewOutcome {
  const byId = new Map(source.exercises.map((e) => [e.plannedExerciseId, e]));
  const common = {
    schemaVersion: EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
    policyVersion: EQUIPMENT_ADAPTATION_POLICY_VERSION_V1,
    catalogVersion: catalog.version,
    athleteLocalDate: source.athleteLocalDate,
    plannedWorkoutId: source.plannedWorkoutId,
    workoutName: source.workoutName,
    availableEquipmentIds: [...source.availableEquipmentIds],
  } as const;

  const inputs = buildEquipmentAdaptationInput(source, catalog);
  if (inputs.kind === "UNSUPPORTED") {
    const decision: SemanticDecision = { resultKind: "REVIEW_REQUIRED", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY", unsupportedPlannedExerciseIds: inputs.unsupported.map((e) => e.plannedExerciseId) };
    const unresolved: EquipmentAdaptationPreviewUnresolvedV1[] = inputs.unsupported.map((e) => ({
      plannedExerciseId: e.plannedExerciseId,
      order: e.order,
      authoredExerciseRef: e.exerciseRef,
      authoredExerciseName: e.displayName,
      reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY",
    }));
    return { ok: true, preview: { ...common, previewFingerprint: computeEquipmentPreviewFingerprint(source, catalog.version, decision), result: "REVIEW_REQUIRED", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY", unresolved } };
  }

  const evaluated = evaluateEquipmentAdaptation(inputs.input);
  if (!evaluated.ok) return { ok: false, code: "EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION" };
  const decision = evaluated.value.data;
  const previewFingerprint = computeEquipmentPreviewFingerprint(source, catalog.version, decision);

  switch (decision.resultKind) {
    case "NO_CHANGE":
      return { ok: true, preview: { ...common, previewFingerprint, result: "NO_CHANGE", reasonCode: "ALL_EQUIPMENT_AVAILABLE", replacements: [] } };
    case "REVIEW_REQUIRED":
      return {
        ok: true,
        preview: {
          ...common,
          previewFingerprint,
          result: "REVIEW_REQUIRED",
          reasonCode: decision.reasonCode,
          unresolved: decision.unresolved.map((u) => {
            const row = byId.get(u.plannedExerciseId)!;
            return { plannedExerciseId: u.plannedExerciseId, order: row.order, authoredExerciseRef: u.authoredExerciseId, authoredExerciseName: row.displayName, reasonCode: u.reasonCode };
          }),
        },
      };
    case "ADJUST_SESSION": {
      const replacements: EquipmentAdaptationPreviewReplacementV1[] = decision.replacements.map((r) => {
        const row = byId.get(r.plannedExerciseId)!;
        const substitute = catalog.getExerciseDefinition(r.substituteExerciseId);
        if (substitute === null) throw new Error(`catalog substitute ${r.substituteExerciseId} vanished`);
        return {
          plannedExerciseId: r.plannedExerciseId,
          order: r.order,
          authoredExerciseRef: r.authoredExerciseId,
          authoredExerciseName: row.displayName,
          substituteExerciseRef: substitute.exerciseRef,
          substituteExerciseName: substitute.displayName,
          reasonCode: r.reasonCode,
          prescriptionPolicy: r.prescription.policy,
          prescription: {
            workingSetCount: r.prescription.workingSetCount,
            sets: r.prescription.sets.map((s) => ({ plannedSetId: s.plannedSetId, order: s.order, setType: s.setType, targetReps: s.targetReps, restSeconds: s.restSeconds })),
            availableTime: r.prescription.availableTime,
            loadResolution: "RESOLVE_FOR_SUBSTITUTE_EXERCISE",
          },
        };
      });
      return { ok: true, preview: { ...common, previewFingerprint, result: "ADJUST_SESSION", reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE", replacements } };
    }
  }
}
