import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  plannedWorkouts,
  type Database,
} from "@vostivo/database";
import type { MissedWorkoutApplyResponseV1, MissedWorkoutNotApplicableErrorV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { MISSED_WORKOUT_POLICY_VERSION_V1 } from "@vostivo/training-engine";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { evaluateMissedWorkoutPreview } from "./missed-workout-preview.js";
import { deriveMissedWorkoutSource, type MissedWorkoutPreviewOptions } from "./missed-workout-preview.service.js";

type ApplicationRow = typeof missedWorkoutScheduleApplications.$inferSelect;

/**
 * Missed Workout / Schedule Adaptation V1 — Slice C: DURABLE ROLL_FORWARD
 * application as an EFFECTIVE SCHEDULE OVERLAY
 * (`docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md` §10).
 *
 * AUTHORED SCHEDULE IS IMMUTABLE: this never touches ProgramVersion,
 * TrainingBlock/Cycle dates or any PlannedWorkout field, never creates a
 * session/claim/receipt/progression artifact — it only writes one
 * `missed_workout_schedule_applications` row + its complete assignment
 * snapshot (and marks the previous ACTIVE one SUPERSEDED), in ONE
 * transaction.
 *
 * The client sends only the fingerprint of the preview the athlete
 * approved. Everything is re-derived inside the transaction with the SAME
 * code as the preview; the application happens only if the current preview
 * has exactly that fingerprint (else 409 MISSED_WORKOUT_PREVIEW_STALE —
 * never a "helpful" apply of a newer recommendation) and is a ROLL_FORWARD
 * (else 409 MISSED_WORKOUT_NOT_APPLICABLE). PREVIEW FINGERPRINT IS A
 * STALE/IDEMPOTENCY GUARD, NOT AUTH: ownership comes from the actor only.
 *
 * Concurrency: the athlete profile row is locked FOR UPDATE first, so all
 * applies of one athlete serialize; under READ COMMITTED every later
 * statement sees what a previous apply committed (its new ACTIVE id changes
 * the fingerprint -> the loser is STALE, or an identical retry finds the
 * existing row). The partial unique index (one ACTIVE per block) and the
 * unique fingerprint index are the DB-level backstops.
 */
@Injectable()
export class MissedWorkoutApplyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(actor: AuthenticatedActor, previewFingerprint: string, options: MissedWorkoutPreviewOptions = {}): Promise<MissedWorkoutApplyResponseV1> {
    if (actor.athleteProfileId === undefined) throw new NotFoundException("Athlete profile not found");
    const athleteProfileId = actor.athleteProfileId;

    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: athleteProfiles.id })
        .from(athleteProfiles)
        .where(and(eq(athleteProfiles.id, athleteProfileId), eq(athleteProfiles.userId, actor.userId)))
        .for("update");
      if (locked === undefined) throw new NotFoundException("Athlete profile not found");

      // IDEMPOTENCY: this athlete already applied exactly this preview (e.g.
      // the first response was lost) -> the existing application, never a
      // duplicate. Scoped to the actor's own profile — another athlete's
      // fingerprint is simply unknown here (and then STALE below).
      const [existing] = await tx
        .select()
        .from(missedWorkoutScheduleApplications)
        .where(and(eq(missedWorkoutScheduleApplications.athleteProfileId, athleteProfileId), eq(missedWorkoutScheduleApplications.previewFingerprint, previewFingerprint)));
      if (existing !== undefined) return toApplyResponse(tx, existing);

      const now = this.clock.now();
      const { source, overlay } = await deriveMissedWorkoutSource(tx, actor, now, options);
      const evaluation = evaluateMissedWorkoutPreview(source);
      if (evaluation.preview.previewFingerprint !== previewFingerprint) throw new ConflictException("MISSED_WORKOUT_PREVIEW_STALE");
      const preview = evaluation.preview;
      if (preview.result !== "ROLL_FORWARD") {
        const body: MissedWorkoutNotApplicableErrorV1 = { statusCode: 409, message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode: preview.reasonCode };
        throw new ConflictException(body);
      }
      // A ROLL_FORWARD only ever comes from an IN_CURRENT_BLOCK source.
      if (evaluation.proposedAssignments === null || source.trainingBlockId === null || source.programVersionId === null) {
        throw new Error("ROLL_FORWARD without a current block / proposed assignments");
      }

      // The ACTIVE application is always a COMPLETE snapshot: this decision's
      // sequence (ROLL_FORWARD) + every other effective date of the previous
      // ACTIVE overlay carried over unchanged (RETAINED) — never stacked.
      const authored = new Map(source.occurrences.map((o) => [o.plannedWorkoutId, o.authoredScheduledLocalDate]));
      const rolled = new Set(evaluation.proposedAssignments.map((a) => a.plannedWorkoutId));
      const retained = (overlay?.assignments ?? [])
        .filter((a) => !rolled.has(a.plannedWorkoutId) && authored.has(a.plannedWorkoutId))
        .sort((a, b) => source.occurrences.findIndex((o) => o.plannedWorkoutId === a.plannedWorkoutId) - source.occurrences.findIndex((o) => o.plannedWorkoutId === b.plannedWorkoutId));

      if (overlay !== null) {
        await tx
          .update(missedWorkoutScheduleApplications)
          .set({ status: "SUPERSEDED", supersededAt: now })
          .where(and(eq(missedWorkoutScheduleApplications.id, overlay.applicationId), eq(missedWorkoutScheduleApplications.status, "ACTIVE")));
      }

      const applicationId = createEntityId();
      const [application] = await tx
        .insert(missedWorkoutScheduleApplications)
        .values({
          id: applicationId,
          athleteProfileId,
          programVersionId: source.programVersionId,
          trainingBlockId: source.trainingBlockId,
          policyVersion: MISSED_WORKOUT_POLICY_VERSION_V1,
          previewFingerprint,
          athleteLocalDate: source.athleteLocalDate,
          trainingTimeZone: source.trainingTimeZone,
          missedPlannedWorkoutId: preview.missedWorkout.plannedWorkoutId,
          missedScheduledLocalDate: preview.missedWorkout.scheduledLocalDate,
          originalNextPlannedWorkoutId: preview.originalNextWorkout?.plannedWorkoutId ?? null,
          reasonCode: preview.reasonCode,
          appliedByUserId: actor.userId,
          appliedAt: now,
          status: "ACTIVE",
          supersedesApplicationId: overlay?.applicationId ?? null,
          supersededAt: null,
        })
        .returning();

      const rows = [
        ...evaluation.proposedAssignments.map((a) => ({ ...a, assignmentKind: "ROLL_FORWARD" as const })),
        ...retained.map((a) => ({ ...a, assignmentKind: "RETAINED" as const })),
      ];
      await tx.insert(missedWorkoutScheduleAssignments).values(
        rows.map((row, sequencePosition) => ({
          id: createEntityId(),
          applicationId,
          sequencePosition,
          plannedWorkoutId: row.plannedWorkoutId,
          assignmentKind: row.assignmentKind,
          authoredScheduledLocalDate: authored.get(row.plannedWorkoutId) ?? null,
          effectiveScheduledLocalDate: row.effectiveScheduledLocalDate,
        })),
      );

      return toApplyResponse(tx, application!);
    });
  }
}

/** The stable response, built from the persisted rows only (so a fresh apply and an idempotent replay are identical). */
async function toApplyResponse(db: Database, application: ApplicationRow): Promise<MissedWorkoutApplyResponseV1> {
  const assignments = await db
    .select()
    .from(missedWorkoutScheduleAssignments)
    .where(and(eq(missedWorkoutScheduleAssignments.applicationId, application.id), eq(missedWorkoutScheduleAssignments.assignmentKind, "ROLL_FORWARD")))
    .orderBy(asc(missedWorkoutScheduleAssignments.sequencePosition));
  const [missed] = await db
    .select({ name: plannedWorkouts.name })
    .from(plannedWorkouts)
    .where(inArray(plannedWorkouts.id, [application.missedPlannedWorkoutId]));
  return {
    application: {
      policyVersion: MISSED_WORKOUT_POLICY_VERSION_V1,
      previewFingerprint: application.previewFingerprint,
      status: application.status,
      appliedAt: application.appliedAt.toISOString(),
    },
    result: "ROLL_FORWARD",
    missedWorkout: { plannedWorkoutId: application.missedPlannedWorkoutId, displayName: missed?.name ?? "", scheduledLocalDate: application.missedScheduledLocalDate },
    effectiveAssignments: assignments.map((a) => ({
      plannedWorkoutId: a.plannedWorkoutId,
      authoredScheduledLocalDate: a.authoredScheduledLocalDate,
      effectiveScheduledLocalDate: a.effectiveScheduledLocalDate,
    })),
    carryoverWorkoutIds: assignments.filter((a) => a.effectiveScheduledLocalDate === null).map((a) => a.plannedWorkoutId),
  };
}
