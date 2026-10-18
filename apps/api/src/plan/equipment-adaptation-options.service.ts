import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { equipmentAdaptationApplications, plannedExercises, type Database } from "@vostivo/database";
import { EQUIPMENT_ADAPTATION_OPTIONS_SCHEMA_V1, type EquipmentAdaptationOptionsResponseV1 } from "@vostivo/contracts";
import { EXERCISE_EQUIPMENT_CATALOG_VERSION_V1 } from "@vostivo/domain";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { resolveEquipmentAdaptationTarget } from "./equipment-adaptation-preview.service.js";
import { computeEquipmentAdaptationOptions } from "./equipment-adaptation-options.js";
import { isEquipmentApplicationApplicable } from "./effective-equipment-adaptation.js";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice D: READ-ONLY equipment
 * choices for today's workout (`GET /api/v1/plan/equipment-adaptation-
 * options`). Same applicability authority as the preview (one
 * interpretation of Today), canonical catalog ids/labels only, and today's
 * still-applicable ACTIVE application's declared inventory (if any) so the
 * athlete's own earlier declaration — never a guess — can seed the sheet.
 * Only SELECTs.
 */
@Injectable()
export class EquipmentAdaptationOptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async options(actor: AuthenticatedActor, plannedWorkoutId: string): Promise<EquipmentAdaptationOptionsResponseV1> {
    const instant = this.clock.now();
    const target = await resolveEquipmentAdaptationTarget(this.db, actor, plannedWorkoutId, instant);
    const exercises = await this.db
      .select({ exerciseRef: plannedExercises.exerciseRef })
      .from(plannedExercises)
      .where(eq(plannedExercises.plannedWorkoutId, target.plannedWorkoutId))
      .orderBy(asc(plannedExercises.orderIndex));

    const [active] = await this.db
      .select()
      .from(equipmentAdaptationApplications)
      .where(and(eq(equipmentAdaptationApplications.userId, actor.userId), eq(equipmentAdaptationApplications.plannedWorkoutId, target.plannedWorkoutId), eq(equipmentAdaptationApplications.status, "ACTIVE")))
      .limit(1);
    const currentApplication =
      active !== undefined && (await isEquipmentApplicationApplicable(this.db, actor, active, instant))
        ? { applicationId: active.id, result: active.result, availableEquipmentIds: active.availableEquipmentIds }
        : null;

    return {
      schemaVersion: EQUIPMENT_ADAPTATION_OPTIONS_SCHEMA_V1,
      catalogVersion: EXERCISE_EQUIPMENT_CATALOG_VERSION_V1,
      plannedWorkoutId: target.plannedWorkoutId,
      athleteLocalDate: target.athleteLocalDate,
      equipmentOptions: computeEquipmentAdaptationOptions(exercises.map((e) => e.exerciseRef)),
      currentApplication,
    };
  }
}
