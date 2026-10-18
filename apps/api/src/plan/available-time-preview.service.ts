import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { Database } from "@vostivo/database";
import type { AvailableTimePreviewResponseV1 } from "@vostivo/contracts";
import { DATABASE } from "../database/database.module.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { computeAvailableTimePreview } from "./available-time-preview.js";
import { findOwnedPlannedWorkoutSource, loadAvailableTimeExerciseRows } from "./available-time-source.js";
import { findMatchingSessions } from "./planned-workout-sessions.js";

/**
 * Available-Time Adaptation V1 — Slice B: READ-ONLY server preview
 * orchestration (`docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md` §17).
 *
 * REAL PLAN -> authoritative server normalization -> `available-time/v1`
 * (packages/training-engine, the only implementation of the policy) ->
 * preview contract. Only ever SELECTs: no EngineDecision, adaptation,
 * ProgramVersion, WorkoutSession, snapshot or Athlete Memory row is
 * written — a preview is a recommendation, never an application.
 *
 * Structure only: it reads the same canonical `planned_exercises`/
 * `planned_sets` rows `createWorkoutPrescriptionFromPlannedWorkout` turns
 * into the prescription a workout START uses, and never touches load, reps,
 * RIR or the progression effective-load overlay (which changes a set's
 * load, never which sets exist).
 */
@Injectable()
export class AvailableTimePreviewService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async preview(actor: AuthenticatedActor, plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1> {
    // Same deny-by-default ownership as `PlanReadService.getWorkoutPreview`:
    // not existing and owned by another athlete are the same 404 (no
    // existence leakage); the request never establishes ownership.
    if (actor.athleteProfileId === undefined) throw new NotFoundException("Planned workout not found");
    const owned = await findOwnedPlannedWorkoutSource(this.db, actor.userId, plannedWorkoutId);
    if (owned === undefined) throw new NotFoundException("Planned workout not found");

    // Pre-start only (Slice B §11): an ACTIVE or COMPLETED session for this
    // occurrence means Resume (or history) wins — never a new adjusted
    // prescription for a workout already underway.
    const sessions = await findMatchingSessions(this.db, actor.userId, [owned.plannedWorkoutId]);
    if (sessions.has(owned.plannedWorkoutId)) throw new ConflictException("WORKOUT_ALREADY_STARTED");

    const exercises = await loadAvailableTimeExerciseRows(this.db, owned.plannedWorkoutId);
    const result = computeAvailableTimePreview({
      plannedWorkoutId: owned.plannedWorkoutId,
      programVersionId: owned.programVersionId,
      availableMinutes,
      exercises,
    });
    // Invalid authored structure fails closed with a stable code — never
    // repaired, never turned into NO_CHANGE. Only the code is exposed.
    if (!result.ok) throw new UnprocessableEntityException(result.error.code);
    return result.value;
  }
}
