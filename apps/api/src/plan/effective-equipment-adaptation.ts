import { and, desc, eq } from "drizzle-orm";
import { equipmentAdaptationApplications, performedExercises, performedSets, workoutSessions, type Database } from "@vostivo/database";
import { exerciseEquipmentCatalogV1, type ExternalWeightLoad, type PrescribedExerciseSubstitutionV1 } from "@vostivo/domain";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { deriveEquipmentAdaptation } from "./equipment-adaptation-preview.service.js";

type EquipmentAdaptationApplication = typeof equipmentAdaptationApplications.$inferSelect;

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C: the ONE server
 * resolution of "which TODAY_ONLY equipment substitutions apply to this
 * planned workout right now", used by the effective Workout Preview (whose
 * prescription is exactly what a local-first START snapshots).
 *
 * START MUST NOT BLINDLY TRUST AN OLD APPLICATION ROW: the ACTIVE
 * application is used only if re-deriving the adaptation NOW, with its own
 * stored inventory, yields its exact fingerprint — same athlete-local day
 * (TODAY_ONLY), same effective date, same authored prescription, same
 * catalog, still pre-start. Anything else (a later day, a changed plan, an
 * already started occurrence) silently falls back to the authored
 * prescription. Read only.
 */
export interface EffectiveEquipmentSubstitution {
  readonly substituteExerciseRef: string;
  readonly substituteDisplayName: string;
  readonly provenance: PrescribedExerciseSubstitutionV1;
  /** The substitute's OWN working load (its own recent history), or `null` (no history: the athlete chooses). Never the authored load, never a conversion. */
  readonly workingLoad: ExternalWeightLoad | null;
}

export async function resolveEffectiveEquipmentSubstitutions(
  db: Database,
  actor: AuthenticatedActor,
  plannedWorkoutId: string,
  authoredDisplayNames: ReadonlyMap<string, string>,
  instant: Date,
): Promise<ReadonlyMap<string, EffectiveEquipmentSubstitution>> {
  const none = new Map<string, EffectiveEquipmentSubstitution>();
  const [application] = await db
    .select()
    .from(equipmentAdaptationApplications)
    .where(and(eq(equipmentAdaptationApplications.userId, actor.userId), eq(equipmentAdaptationApplications.plannedWorkoutId, plannedWorkoutId), eq(equipmentAdaptationApplications.status, "ACTIVE")));
  if (application === undefined || application.result === "NO_CHANGE") return none;
  if (!(await isEquipmentApplicationApplicable(db, actor, application, instant))) return none;

  const result = new Map<string, EffectiveEquipmentSubstitution>();
  for (const replacement of application.replacements) {
    const substitute = exerciseEquipmentCatalogV1.getExerciseDefinition(replacement.substituteExerciseRef);
    if (substitute === null) return none; // unreachable after a matching fingerprint; fail closed anyway
    result.set(replacement.plannedExerciseId, {
      substituteExerciseRef: substitute.exerciseRef,
      substituteDisplayName: substitute.displayName,
      provenance: {
        kind: "TEMPORARY_EQUIPMENT",
        reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE",
        authoredExerciseRef: replacement.authoredExerciseRef,
        authoredDisplayName: authoredDisplayNames.get(replacement.plannedExerciseId) ?? replacement.authoredExerciseRef,
        equipmentApplicationId: application.id,
        policyVersion: "equipment-adaptation/v1",
        catalogVersion: application.catalogVersion,
      },
      workingLoad: await resolveSubstituteWorkingLoad(db, actor.userId, substitute.exerciseRef),
    });
  }
  return result;
}

/**
 * Whether a durable application still applies at `instant`: re-deriving
 * the adaptation with its own stored inventory and catalog version yields
 * its exact fingerprint (same athlete-local day, effective date, authored
 * prescription, catalog, still pre-start). Anything else — including any
 * derivation refusal (another day, started, out of block, missing zone…) —
 * is `false`. Read only; shared by the effective Workout Preview and START.
 */
export async function isEquipmentApplicationApplicable(
  db: Database,
  actor: AuthenticatedActor,
  application: Pick<EquipmentAdaptationApplication, "plannedWorkoutId" | "catalogVersion" | "availableEquipmentIds" | "previewFingerprint">,
  instant: Date,
): Promise<boolean> {
  try {
    const derived = await deriveEquipmentAdaptation(db, actor, { plannedWorkoutId: application.plannedWorkoutId, catalogVersion: application.catalogVersion, availableEquipmentIds: application.availableEquipmentIds }, instant);
    return derived.preview.previewFingerprint === application.previewFingerprint;
  } catch {
    return false;
  }
}

/**
 * Load for a SUBSTITUTE is resolved for the substitute's OWN identity only:
 * the uniform working load of its most recent exposure (the last session in
 * which this athlete performed THAT exercise). Conservative — no increase,
 * no progression, no kg conversion from the authored exercise. No history
 * (or a non-uniform last exposure) -> `null`: no prescribed load, the
 * athlete chooses (and the substitute's own Previous guides them).
 */
export async function resolveSubstituteWorkingLoad(db: Database, userId: string, exerciseRef: string): Promise<ExternalWeightLoad | null> {
  const rows = await db
    .select({
      workoutSessionId: performedExercises.workoutSessionId,
      loadKind: performedSets.loadKind,
      loadAmountMilli: performedSets.loadAmountMilli,
      loadUnit: performedSets.loadUnit,
      loadBasis: performedSets.loadBasis,
    })
    .from(performedSets)
    .innerJoin(performedExercises, eq(performedExercises.id, performedSets.performedExerciseId))
    .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
    .where(and(eq(workoutSessions.userId, userId), eq(performedExercises.exerciseRef, exerciseRef), eq(performedSets.setType, "WORKING"), eq(performedSets.completionState, "COMPLETED")))
    .orderBy(desc(workoutSessions.startedAt), desc(performedSets.completedAt))
    .limit(50);
  const latestSession = rows[0]?.workoutSessionId;
  if (latestSession === undefined) return null;
  const latest = rows.filter((row) => row.workoutSessionId === latestSession);
  const first = latest[0]!;
  const uniform = latest.every((row) => row.loadAmountMilli === first.loadAmountMilli && row.loadUnit === first.loadUnit && row.loadBasis === first.loadBasis && row.loadKind === first.loadKind);
  if (!uniform || first.loadKind !== "EXTERNAL_WEIGHT") return null;
  return { kind: "EXTERNAL_WEIGHT", amountMilli: first.loadAmountMilli, unit: first.loadUnit, basis: first.loadBasis };
}
