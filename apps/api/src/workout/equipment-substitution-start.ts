import { and, eq } from "drizzle-orm";
import { equipmentAdaptationApplications, type Database } from "@vostivo/database";
import { readSnapshotExerciseIdentities, snapshotDeclaresSubstitution, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { findCanonicalOccurrenceSessions } from "@vostivo/progression-application";
import type { StartProvenance } from "../plan/planned-provenance.js";
import { isEquipmentApplicationApplicable } from "../plan/effective-equipment-adaptation.js";

type EquipmentAdaptationApplication = typeof equipmentAdaptationApplications.$inferSelect;

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C: START exercise
 * identity integrity, decided in full BEFORE any write (the caller holds
 * the planned-occurrence lock, so Apply and START are serialized).
 *
 * CLIENT CANNOT CHANGE EXERCISE IDENTITY AT START. The server derives the
 * authoritative identity of every slot and the snapshot must agree with it
 * exactly — otherwise REJECTED (no session, no claim, no consumption):
 *
 * - The GOVERNING application of the occurrence is:
 *   - already started (a canonical claim exists): the application consumed
 *     by the canonical session, if any — a later (secondary) START must
 *     perform the same replacement reality;
 *   - not started: the ACTIVE application if it still applies (re-derived
 *     fingerprint match at `startedAt` OR at server `now` — a client cannot
 *     escape an applicable application by lying about `startedAt`);
 *   - otherwise none.
 * - A slot the governing application replaces: performed `exerciseRef` ==
 *   the durable substitute, with EXACT provenance (authored ref == the
 *   live PlannedExercise == the durable replacement, authored display name
 *   == the live PlannedExercise, application id, policy, catalog version).
 *   Every replaced slot must be present exactly once — omitting it,
 *   swapping the substitute or starting the authored exercise is REJECTED:
 *   AN ACTIVE EQUIPMENT APPLICATION CANNOT BE SILENTLY BYPASSED.
 * - Every other slot: no `substitution`, and `exerciseRef` == the live
 *   authored PlannedExercise. EVERY EXERCISE IDENTITY CHANGE REQUIRES
 *   SERVER-VALIDATED SUBSTITUTION PROVENANCE; a well-formed but fake
 *   substitution object legitimizes nothing.
 * - Duplicate slots are REJECTED. Omitting a non-replaced slot changes no
 *   identity and stays the existing behavior (Available-Time selection).
 * - UNPLANNED: may never claim a substitution (its exercises are ad hoc).
 *
 * Lifecycle (applied by the caller only when this START creates the
 * CANONICAL claim): CANONICAL START LEAVES NO ACTIVE EQUIPMENT APPLICATION
 * BEHIND — the applicable ACTIVE row (ADJUST or NO_CHANGE) it started from
 * becomes CONSUMED; an ACTIVE row that no longer applies (another day, a
 * changed plan) is retired as SUPERSEDED, unused.
 */
export type EquipmentSubstitutionStartDecision =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly consumeApplicationId: string | null; readonly retireApplicationId: string | null };

const REJECTED = { accepted: false } as const;

export async function decideEquipmentSubstitutionStart(
  tx: Database,
  userId: string,
  provenance: StartProvenance,
  snapshot: WorkoutPrescriptionV1,
  startedAt: Date,
  now: Date,
): Promise<EquipmentSubstitutionStartDecision> {
  if (provenance.kind !== "PLANNED") {
    return snapshotDeclaresSubstitution(snapshot) ? REJECTED : { accepted: true, consumeApplicationId: null, retireApplicationId: null };
  }
  const identities = readSnapshotExerciseIdentities(snapshot);
  if (!identities.ok) return REJECTED;
  const plannedWorkoutId = provenance.source.plannedWorkoutId;

  const { governing, consumeApplicationId, retireApplicationId } = await resolveGoverningApplication(tx, userId, plannedWorkoutId, startedAt, now);
  const replacements = new Map((governing?.replacements ?? []).map((replacement) => [replacement.plannedExerciseId, replacement]));
  const authored = new Map(provenance.exercises.map((exercise) => [exercise.id, exercise]));

  const seenSlots = new Set<string>();
  for (const identity of identities.value) {
    if (seenSlots.has(identity.prescriptionExerciseId)) return REJECTED;
    seenSlots.add(identity.prescriptionExerciseId);
    const slot = authored.get(identity.prescriptionExerciseId);
    if (slot === undefined) return REJECTED; // unreachable after provenance; fail closed anyway
    const replacement = replacements.get(identity.prescriptionExerciseId);
    if (replacement === undefined) {
      if (identity.substitution !== null || identity.exerciseRef !== slot.exerciseRef) return REJECTED;
      continue;
    }
    const substitution = identity.substitution;
    if (
      governing === null ||
      substitution === null ||
      identity.exerciseRef !== replacement.substituteExerciseRef ||
      slot.exerciseRef !== replacement.authoredExerciseRef ||
      substitution.authoredExerciseRef !== replacement.authoredExerciseRef ||
      substitution.authoredDisplayName !== slot.displayName ||
      substitution.equipmentApplicationId !== governing.id ||
      substitution.policyVersion !== governing.policyVersion ||
      substitution.catalogVersion !== governing.catalogVersion
    ) {
      return REJECTED;
    }
  }
  // Every server-derived replacement must be performed — never silently dropped.
  for (const plannedExerciseId of replacements.keys()) if (!seenSlots.has(plannedExerciseId)) return REJECTED;

  return { accepted: true, consumeApplicationId, retireApplicationId };
}

async function resolveGoverningApplication(
  tx: Database,
  userId: string,
  plannedWorkoutId: string,
  startedAt: Date,
  now: Date,
): Promise<{ governing: EquipmentAdaptationApplication | null; consumeApplicationId: string | null; retireApplicationId: string | null }> {
  const canonical = (await findCanonicalOccurrenceSessions(tx, userId, [plannedWorkoutId])).get(plannedWorkoutId);
  if (canonical !== undefined) {
    const [consumed] = await tx
      .select()
      .from(equipmentAdaptationApplications)
      .where(
        and(
          eq(equipmentAdaptationApplications.userId, userId),
          eq(equipmentAdaptationApplications.plannedWorkoutId, plannedWorkoutId),
          eq(equipmentAdaptationApplications.consumedByWorkoutSessionId, canonical.workoutSessionId),
        ),
      )
      .limit(1);
    return { governing: consumed ?? null, consumeApplicationId: null, retireApplicationId: null };
  }

  const [active] = await tx
    .select()
    .from(equipmentAdaptationApplications)
    .where(and(eq(equipmentAdaptationApplications.userId, userId), eq(equipmentAdaptationApplications.plannedWorkoutId, plannedWorkoutId), eq(equipmentAdaptationApplications.status, "ACTIVE")))
    .limit(1);
  if (active === undefined) return { governing: null, consumeApplicationId: null, retireApplicationId: null };

  const actor = { userId, athleteProfileId: active.athleteProfileId };
  const applicable = (await isEquipmentApplicationApplicable(tx, actor, active, startedAt)) || (await isEquipmentApplicationApplicable(tx, actor, active, now));
  return applicable ? { governing: active, consumeApplicationId: active.id, retireApplicationId: null } : { governing: null, consumeApplicationId: null, retireApplicationId: active.id };
}

/** ACTIVE -> CONSUMED by the canonical session, in the START transaction. Guarded on ACTIVE (never resurrects a superseded row). */
export async function consumeEquipmentApplication(tx: Database, applicationId: string, workoutSessionId: string, consumedAt: Date): Promise<void> {
  await tx
    .update(equipmentAdaptationApplications)
    .set({ status: "CONSUMED", consumedByWorkoutSessionId: workoutSessionId, consumedAt })
    .where(and(eq(equipmentAdaptationApplications.id, applicationId), eq(equipmentAdaptationApplications.status, "ACTIVE")));
}

/** ACTIVE -> SUPERSEDED (retired unused) when the canonical START claimed the occurrence while the row no longer applied. Guarded on ACTIVE. */
export async function retireEquipmentApplication(tx: Database, applicationId: string, retiredAt: Date): Promise<void> {
  await tx
    .update(equipmentAdaptationApplications)
    .set({ status: "SUPERSEDED", supersededAt: retiredAt })
    .where(and(eq(equipmentAdaptationApplications.id, applicationId), eq(equipmentAdaptationApplications.status, "ACTIVE")));
}
