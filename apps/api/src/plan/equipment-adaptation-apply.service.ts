import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { equipmentAdaptationApplications, type Database } from "@vostivo/database";
import {
  EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
  type EquipmentAdaptationApplyRequestV1,
  type EquipmentAdaptationApplyResponseV1,
  type EquipmentAdaptationPreviewStaleErrorV1,
  type EquipmentAdaptationReviewRequiredErrorV1,
} from "@vostivo/contracts";
import { createEntityId, exerciseEquipmentCatalogV1 } from "@vostivo/domain";
import { EQUIPMENT_ADAPTATION_POLICY_VERSION_V1 } from "@vostivo/training-engine";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { deriveEquipmentAdaptation } from "./equipment-adaptation-preview.service.js";
import { lockPlannedOccurrence } from "./occurrence-lock.js";

type ApplicationRow = typeof equipmentAdaptationApplications.$inferSelect;

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C: DURABLE TODAY_ONLY
 * application (`docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md` §12).
 *
 * PREVIEW IS NOT AUTHORITY: inside ONE transaction (holding the planned-
 * occurrence advisory lock that START also takes) the server re-derives the
 * whole adaptation from canonical current state with the SAME code as the
 * preview — time zone, athlete-local today, ACTIVE version + current block,
 * effective date, occurrence state, catalog, authored prescription — and
 * applies only if the recomputed fingerprint equals the submitted one.
 * Only server-derived facts are persisted. The authored plan is never
 * touched.
 *
 * - Same fingerprint already ACTIVE/CONSUMED for this workout -> that
 *   application (idempotent retry; never a duplicate).
 * - A newer applied preview (changed inventory, or NO_CHANGE = "no
 *   equipment change today") SUPERSEDES the unconsumed ACTIVE one.
 * - REVIEW_REQUIRED is never applicable; a started/completed occurrence is
 *   never adapted (NOT_APPLICABLE from the derivation).
 */
@Injectable()
export class EquipmentAdaptationApplyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(actor: AuthenticatedActor, request: EquipmentAdaptationApplyRequestV1): Promise<EquipmentAdaptationApplyResponseV1> {
    if (actor.athleteProfileId === undefined) throw new NotFoundException("Planned workout not found");
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      await lockPlannedOccurrence(tx, actor.userId, request.plannedWorkoutId);

      // Idempotent retry (e.g. the first response was lost): only ever the actor's own rows.
      const [existing] = await tx
        .select()
        .from(equipmentAdaptationApplications)
        .where(
          and(
            eq(equipmentAdaptationApplications.userId, actor.userId),
            eq(equipmentAdaptationApplications.plannedWorkoutId, request.plannedWorkoutId),
            eq(equipmentAdaptationApplications.previewFingerprint, request.previewFingerprint),
            inArray(equipmentAdaptationApplications.status, ["ACTIVE", "CONSUMED"]),
          ),
        );
      if (existing !== undefined) return toApplyResponse(existing);

      const derived = await deriveEquipmentAdaptation(tx, actor, request, now);
      const preview = derived.preview;
      if (preview.previewFingerprint !== request.previewFingerprint) {
        const body: EquipmentAdaptationPreviewStaleErrorV1 = { statusCode: 409, message: "EQUIPMENT_PREVIEW_STALE" };
        throw new ConflictException(body);
      }
      if (preview.result === "REVIEW_REQUIRED") {
        const body: EquipmentAdaptationReviewRequiredErrorV1 = { statusCode: 409, message: "EQUIPMENT_ADAPTATION_REVIEW_REQUIRED", reasonCode: preview.reasonCode };
        throw new ConflictException(body);
      }

      const [superseded] = await tx
        .update(equipmentAdaptationApplications)
        .set({ status: "SUPERSEDED", supersededAt: now })
        .where(
          and(
            eq(equipmentAdaptationApplications.userId, actor.userId),
            eq(equipmentAdaptationApplications.plannedWorkoutId, request.plannedWorkoutId),
            eq(equipmentAdaptationApplications.status, "ACTIVE"),
          ),
        )
        .returning({ id: equipmentAdaptationApplications.id });

      const [inserted] = await tx
        .insert(equipmentAdaptationApplications)
        .values({
          id: createEntityId(),
          userId: actor.userId,
          athleteProfileId: derived.athleteProfileId,
          plannedWorkoutId: preview.plannedWorkoutId,
          programVersionId: derived.programVersionId,
          trainingBlockId: derived.trainingBlockId,
          scope: "TODAY_ONLY",
          athleteLocalDate: preview.athleteLocalDate,
          trainingTimeZone: derived.trainingTimeZone,
          previewSchemaVersion: EQUIPMENT_ADAPTATION_PREVIEW_SCHEMA_V1,
          policyVersion: EQUIPMENT_ADAPTATION_POLICY_VERSION_V1,
          catalogVersion: preview.catalogVersion,
          previewFingerprint: preview.previewFingerprint,
          availableEquipmentIds: [...preview.availableEquipmentIds],
          result: preview.result,
          replacements: preview.result === "ADJUST_SESSION" ? preview.replacements.map((r) => ({ plannedExerciseId: r.plannedExerciseId, order: r.order, authoredExerciseRef: r.authoredExerciseRef, substituteExerciseRef: r.substituteExerciseRef })) : [],
          status: "ACTIVE",
          supersedesApplicationId: superseded?.id ?? null,
          supersededAt: null,
          consumedByWorkoutSessionId: null,
          consumedAt: null,
          appliedByUserId: actor.userId,
          appliedAt: now,
        })
        .returning();
      return toApplyResponse(inserted!);
    });
  }
}

/** Built only from the persisted row, so a first apply and its retry are identical. */
function toApplyResponse(row: ApplicationRow): EquipmentAdaptationApplyResponseV1 {
  return {
    applicationId: row.id,
    scope: row.scope,
    plannedWorkoutId: row.plannedWorkoutId,
    athleteLocalDate: row.athleteLocalDate,
    previewFingerprint: row.previewFingerprint,
    status: row.status,
    result: row.result,
    replacements: row.replacements.map((r) => ({
      plannedExerciseId: r.plannedExerciseId,
      order: r.order,
      authoredExerciseRef: r.authoredExerciseRef,
      substituteExerciseRef: r.substituteExerciseRef,
      substituteExerciseName: exerciseEquipmentCatalogV1.getExerciseDefinition(r.substituteExerciseRef)?.displayName ?? r.substituteExerciseRef,
    })),
    appliedAt: row.appliedAt.toISOString(),
  };
}
