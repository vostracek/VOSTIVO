import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  performedExercises,
  performedSets,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { validateExternalWeightLoad, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { claimPlannedOccurrence, enqueueProgressionEvaluateSession } from "@vostivo/progression-application";
import { createLogger } from "@vostivo/observability";
import { resolveStartProvenance } from "../plan/planned-provenance.js";
import { lockPlannedOccurrence } from "../plan/occurrence-lock.js";
import { consumeEquipmentApplication, decideEquipmentSubstitutionStart, retireEquipmentApplication } from "./equipment-substitution-start.js";
import { decideAvailableTimeStart, insertAvailableTimeApplication, type AvailableTimeVerification } from "./available-time-start.js";
import type {
  CompleteSetCommandV1,
  FinishWorkoutSessionCommandV1,
  ReopenSetCommandV1,
  StartWorkoutSessionCommandV1,
  SyncOutcome,
  WorkoutCommandAcknowledgementV1,
  WorkoutCommandV1,
} from "@vostivo/contracts";

type StoredOutcome = "APPLIED" | "STALE" | "REJECTED";

const logger = createLogger({ serviceName: "vostivo-api-workout-commands" });

/**
 * Signals that this transaction lost the receipt-insert race to a
 * concurrent processor of the exact same commandId (spec section 19/20) —
 * caught outside the transaction so it rolls back cleanly, then the
 * winner's already-committed receipt is reported instead.
 */
class DuplicateCommandRaceLoss extends Error {}

/**
 * Auth & Local Athlete Boundary V1 Slice A — the command targets a server
 * resource the actor does not own (or that does not exist for the actor):
 * another user's session/performed set, another user's planned workout, or
 * a session id already taken by another user. Thrown INSIDE the transaction
 * so it rolls back completely, then reported as a generic `REJECTED`
 * WITHOUT a receipt: a foreign-ownership attempt never leaves durable
 * idempotency state behind. Replaying it simply re-evaluates to the same
 * rejection. Same-owner validation failures (bad load, Finish causal gate,
 * snapshot mismatch, equipment/Available-Time contradictions, malformed
 * provenance) are NOT this — they keep their persisted REJECTED receipt.
 */
class OwnershipUnresolvedRejection extends Error {}

/**
 * Signals that a DIFFERENT commandId tried to claim a (session, sessionSeq)
 * pair already recorded against another command (Active Workout Finish
 * Causal Boundary Fix, AW-ORDER-007) — caught outside the transaction so
 * the whole mutation rolls back cleanly and this command is reported
 * REJECTED, never partially applied.
 */
class SessionSeqReuseConflict extends Error {}

/**
 * The one place that distinguishes a genuine Postgres unique-violation
 * (SQLSTATE 23505) from any other failure. `workout_command_receipts` has
 * exactly two unique constraints: the `commandId` primary key (already
 * absorbed silently by `onConflictDoNothing` below, so it can never reach
 * here as a thrown error) and the new `(workout_session_id, session_seq)`
 * partial index — so any 23505 that DOES reach here can only be the
 * latter. drizzle-orm's postgres-js driver wraps the raw `PostgresError`
 * in its own error type, exposing the original via `.cause` — checked
 * either directly or one level down.
 */
function isPostgresUniqueViolation(error: unknown): boolean {
  return hasUniqueViolationCode(error) || hasUniqueViolationCode(getCause(error));
}

function hasUniqueViolationCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function getCause(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
}

interface SetMutationResult {
  readonly outcome: StoredOutcome;
  /** Non-null only once ownership is confirmed — see the receipt-population note on `workoutCommandReceipts`. */
  readonly sessionId: string | null;
  /**
   * Progression Evaluation Orchestration V1 — non-null exactly when this
   * command durably changed COMPLETED-session evidence and progression
   * re-evaluation should be scheduled for it: a `FINISH_WORKOUT_SESSION_V1`
   * command's genuine ACTIVE -> COMPLETED transition, or a
   * `COMPLETE_SET_V1`/`REOPEN_SET_V1` applied to an ALREADY-`COMPLETED`
   * session under the Finish causal boundary (a late-but-causally-valid
   * correction — see `applyCompleteSet`/`applyReopenSet`). `null`
   * otherwise: a no-op duplicate FINISH (the watermark never moves twice),
   * any `REJECTED`/`STALE` outcome, or a mutation against a still-`ACTIVE`
   * session (evaluated once at FINISH, covering every exercise, not
   * per-set while the session is still in progress).
   */
  readonly progressionTriggerSessionId: string | null;
}

/**
 * Processes exactly one workout sync command, transactionally (spec
 * section 29): canonical mutation, command receipt, and change-cursor
 * entry commit together or not at all. See
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md for the full algorithm
 * (idempotency, revision-gated convergence, BOLA protection).
 *
 * `boss` is the already-`.start()`ed API-side pg-boss producer (Progression
 * Evaluation Orchestration V1) — when this command's canonical mutation
 * durably changes COMPLETED-session evidence, a
 * `progression-evaluate-session-v1` job is enqueued INSIDE the exact same
 * transaction as the mutation itself, via pg-boss's Drizzle adapter (see
 * `@vostivo/progression-application`'s `enqueueProgressionEvaluateSession`)
 * — so the job either commits with the mutation or never exists at all,
 * with no crash window between the two. The athlete-facing logging path
 * never evaluates progression inline; only `apps/worker` ever calls
 * `ProgressionEvaluationService`.
 */
export async function processWorkoutCommand(
  db: Database,
  boss: PgBoss,
  userId: string,
  command: WorkoutCommandV1,
  /** Server time (injectable for tests); START uses it so a client `startedAt` can never escape an applicable equipment application. */
  now: Date = new Date(),
): Promise<WorkoutCommandAcknowledgementV1> {
  const existingReceipt = await findReceipt(db, userId, command.commandId);
  if (existingReceipt !== undefined) {
    return { commandId: command.commandId, outcome: toClientOutcome(existingReceipt, true) };
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      const mutation = await applyMutation(tx, userId, command, now);

      let receiptInsert;
      try {
        receiptInsert = await tx
          .insert(workoutCommandReceipts)
          .values({
            commandId: command.commandId,
            commandType: command.type,
            schemaVersion: command.schemaVersion,
            userId,
            outcome: mutation.outcome,
            workoutSessionId: mutation.sessionId,
            // Paired with workoutSessionId: null whenever ownership
            // didn't resolve a session (e.g. a BOLA-rejected attempt),
            // never a sessionSeq claim with no session to anchor it.
            sessionSeq: mutation.sessionId !== null ? sessionSeqFor(command) : null,
          })
          .onConflictDoNothing({ target: [workoutCommandReceipts.userId, workoutCommandReceipts.commandId] })
          .returning({ commandId: workoutCommandReceipts.commandId });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new SessionSeqReuseConflict();
        }
        throw error;
      }

      if (receiptInsert.length === 0) {
        throw new DuplicateCommandRaceLoss();
      }

      if (mutation.outcome === "APPLIED") {
        await tx.insert(workoutChangeCursor).values({
          userId,
          resourceType: resourceTypeFor(command),
          resourceId: resourceIdFor(command),
          commandType: command.type,
        });
      }

      if (mutation.progressionTriggerSessionId !== null) {
        await enqueueProgressionEvaluateSession(boss, tx, sql, {
          workoutSessionId: mutation.progressionTriggerSessionId,
          triggerCommandId: command.commandId,
        });
      }

      return mutation.outcome;
    });

    return { commandId: command.commandId, outcome: toClientOutcome({ outcome }, false) };
  } catch (error) {
    if (error instanceof OwnershipUnresolvedRejection) {
      return { commandId: command.commandId, outcome: "REJECTED" };
    }
    if (error instanceof DuplicateCommandRaceLoss) {
      const winner = await findReceipt(db, userId, command.commandId);
      if (winner !== undefined) {
        return { commandId: command.commandId, outcome: toClientOutcome(winner, true) };
      }
    }
    if (error instanceof SessionSeqReuseConflict) {
      // A different commandId already claimed this (session, sessionSeq)
      // pair — a buggy or malicious client reusing a sequence number.
      // The whole transaction rolled back; nothing was applied.
      return { commandId: command.commandId, outcome: "REJECTED" };
    }
    throw error;
  }
}

async function applyMutation(
  tx: Database,
  userId: string,
  command: WorkoutCommandV1,
  now: Date,
): Promise<SetMutationResult> {
  switch (command.type) {
    case "START_WORKOUT_SESSION_V1":
      return {
        outcome: await applyStartWorkoutSession(tx, userId, command, now),
        sessionId: null,
        progressionTriggerSessionId: null,
      };
    case "COMPLETE_SET_V1":
      return applyCompleteSet(tx, userId, command);
    case "REOPEN_SET_V1":
      return applyReopenSet(tx, userId, command);
    case "FINISH_WORKOUT_SESSION_V1": {
      const result = await applyFinishWorkoutSession(tx, userId, command);
      return {
        outcome: result.outcome,
        sessionId: null,
        progressionTriggerSessionId: result.transitioned ? command.workoutSessionId : null,
      };
    }
  }
}

/**
 * Only `COMPLETE_SET_V1`/`REOPEN_SET_V1` consume a set-mutation sequence
 * slot — see the receipt-population note on `workoutCommandReceipts`.
 */
function sessionSeqFor(command: WorkoutCommandV1): number | null {
  return command.type === "COMPLETE_SET_V1" || command.type === "REOPEN_SET_V1" ? command.sessionSeq : null;
}

async function applyStartWorkoutSession(
  tx: Database,
  userId: string,
  command: StartWorkoutSessionCommandV1,
  now: Date,
): Promise<StoredOutcome> {
  // Every START's claimed Plan provenance is verified before anything is
  // written: an owned planned workout (with only its own exercise/set
  // identities) or a genuinely unplanned prescription. Foreign provenance
  // -> REJECTED, nothing persisted (see planned-provenance.ts); another
  // user's planned workout is a foreign-ownership failure (no receipt).
  const provenance = await resolveStartProvenance(tx, userId, command.prescription);
  if (!provenance.ok) {
    if (provenance.error === "FOREIGN_PLANNED_WORKOUT") throw new OwnershipUnresolvedRejection();
    return "REJECTED";
  }

  // Serialize with a concurrent TODAY_ONLY equipment apply of the same
  // occurrence (the apply re-checks "not started" under the same lock).
  if (provenance.value.kind === "PLANNED") await lockPlannedOccurrence(tx, userId, provenance.value.source.plannedWorkoutId);

  // Temporary Equipment / Gym Adaptation V1 Slice C: every slot's exercise
  // identity must equal the server's effective identity (authored, or the
  // governing equipment application's exact replacement), or nothing is
  // written (see equipment-substitution-start.ts).
  const equipment = await decideEquipmentSubstitutionStart(tx, userId, provenance.value, command.prescription, new Date(command.startedAt), now);
  if (!equipment.accepted) return "REJECTED";

  // Available-Time Adaptation V1 Slice C: an adjusted START is decided in
  // full BEFORE any write — a proven contradiction is REJECTED (no session,
  // no application); otherwise it is accepted with VERIFIED/STALE/
  // UNVERIFIED (see available-time-start.ts).
  const application = command.availableTimeApplication;
  let verification: AvailableTimeVerification | undefined;
  if (application !== undefined) {
    const decision = decideAvailableTimeStart(application, provenance.value, command.prescription);
    if (!decision.accepted) return "REJECTED";
    verification = decision.verification;
  }

  const inserted = await tx
    .insert(workoutSessions)
    .values({
      id: command.workoutSessionId,
      userId,
      prescriptionSnapshot: command.prescription,
      startedAt: new Date(command.startedAt),
      status: "ACTIVE",
    })
    .onConflictDoNothing({ target: workoutSessions.id })
    .returning({ id: workoutSessions.id });

  if (inserted.length > 0) {
    // Planned Workout Occurrence Authority V1 — same transaction as the
    // session: the FIRST valid server-accepted START of a planned workout
    // claims its occurrence (CANONICAL); a later distinct START of the same
    // occurrence is still accepted, as SECONDARY. Normal and adjusted STARTs
    // compete for the one claim; unplanned STARTs never claim.
    if (provenance.value.kind === "PLANNED") {
      const claim = await claimPlannedOccurrence(tx, {
        userId,
        plannedWorkoutId: provenance.value.source.plannedWorkoutId,
        workoutSessionId: command.workoutSessionId,
      });
      // Only the CANONICAL START settles the TODAY_ONLY application: no
      // ACTIVE equipment application survives the occurrence's start.
      if (claim.claimCreated && equipment.consumeApplicationId !== null) {
        await consumeEquipmentApplication(tx, equipment.consumeApplicationId, command.workoutSessionId, now);
      }
      if (claim.claimCreated && equipment.retireApplicationId !== null) {
        await retireEquipmentApplication(tx, equipment.retireApplicationId, now);
      }
      logger.info(
        claim.claimCreated
          ? "planned occurrence claimed (CANONICAL session)"
          : "planned occurrence already claimed — session accepted as SECONDARY",
        { workoutSessionId: command.workoutSessionId, canonicalWorkoutSessionId: claim.canonicalWorkoutSessionId, role: claim.role },
      );
    }

    // Same transaction as the session itself: the session and its
    // Available-Time application commit together or not at all.
    if (application !== undefined && verification !== undefined) {
      await insertAvailableTimeApplication(tx, userId, command.workoutSessionId, application, verification);
    }
    return "APPLIED";
  }

  // spec section 19 (WDI-SYNC-002): duplicate START is idempotent — but
  // only for the same owner (BOLA: never let a colliding id be silently
  // claimed by a different user; a session id taken by someone else is a
  // foreign-ownership rejection with no receipt).
  const [existing] = await tx
    .select({ userId: workoutSessions.userId })
    .from(workoutSessions)
    .where(eq(workoutSessions.id, command.workoutSessionId))
    .limit(1);

  if (existing === undefined || existing.userId !== userId) throw new OwnershipUnresolvedRejection();
  return "APPLIED";
}

/**
 * Performed reality stays bound to the session's own immutable prescription
 * snapshot (Full Athlete Journey E2E Audit V1): the snapshot is the only
 * exercise identity START validated, so a completed set may never re-point a
 * planned slot to another `exerciseRef`, attach to a set the snapshot does
 * not contain (e.g. one Available-Time removed), or claim a planned set for
 * an unplanned exercise. A legacy slot without an `exerciseRef` keeps the
 * previous behavior (the mobile client refuses to complete those).
 */
function matchesSessionPrescription(snapshot: WorkoutPrescriptionV1, command: CompleteSetCommandV1): boolean {
  if (command.prescriptionExerciseId === null) return command.prescriptionSetId === null;
  const exercise = snapshot.exercises.find((e) => e.prescriptionExerciseId === command.prescriptionExerciseId);
  if (exercise === undefined) return false;
  if (exercise.exerciseRef !== null && exercise.exerciseRef !== command.exerciseRef) return false;
  return command.prescriptionSetId === null || exercise.sets.some((set) => set.prescriptionSetId === command.prescriptionSetId);
}

async function applyCompleteSet(
  tx: Database,
  userId: string,
  command: CompleteSetCommandV1,
): Promise<SetMutationResult> {
  const [session] = await tx
    .select({ userId: workoutSessions.userId, status: workoutSessions.status, finishSeq: workoutSessions.finishSeq, prescriptionSnapshot: workoutSessions.prescriptionSnapshot })
    .from(workoutSessions)
    .where(eq(workoutSessions.id, command.workoutSessionId))
    .limit(1);
  if (session === undefined || session.userId !== userId) throw new OwnershipUnresolvedRejection(); // BOLA (spec 25)

  // From here on, ownership is confirmed — this command's sessionSeq is a
  // legitimate claim by its actual owner, even if rejected below for
  // other reasons (bad load, or the Finish causal-boundary gate).
  const sessionId = command.workoutSessionId;

  const loadValidation = validateExternalWeightLoad(command.actualLoad);
  if (!loadValidation.ok) return { outcome: "REJECTED", sessionId, progressionTriggerSessionId: null }; // WDI-SYNC-007

  // Finish causal boundary (Active Workout Finish Causal Boundary Fix):
  // once COMPLETED, only a command whose sessionSeq was validly issued
  // BEFORE this session's local Finish transition (sessionSeq <=
  // finishSeq) may still apply — a late-delivered but causally-earlier
  // command. A higher sessionSeq could only have been created by a client
  // that ignored its own local terminal invariant (a legitimate client
  // never generates one), so it is rejected as an ordinary Active Workout
  // mutation attempted after Finish.
  if (session.status === "COMPLETED" && (session.finishSeq === null || command.sessionSeq > session.finishSeq)) {
    return { outcome: "REJECTED", sessionId, progressionTriggerSessionId: null };
  }

  if (!matchesSessionPrescription(session.prescriptionSnapshot as WorkoutPrescriptionV1, command)) {
    return { outcome: "REJECTED", sessionId, progressionTriggerSessionId: null };
  }

  const exerciseInsert = await tx
    .insert(performedExercises)
    .values({
      id: command.performedExerciseId,
      workoutSessionId: command.workoutSessionId,
      prescriptionExerciseId: command.prescriptionExerciseId,
      exerciseRef: command.exerciseRef,
      displayName: command.exerciseDisplayName,
      orderIndex: command.exerciseOrder,
    })
    .onConflictDoNothing({ target: performedExercises.id })
    .returning({ id: performedExercises.id });

  if (exerciseInsert.length === 0) {
    const [existingExercise] = await tx
      .select({ workoutSessionId: performedExercises.workoutSessionId, prescriptionExerciseId: performedExercises.prescriptionExerciseId })
      .from(performedExercises)
      .where(eq(performedExercises.id, command.performedExerciseId))
      .limit(1);
    if (
      existingExercise === undefined ||
      existingExercise.workoutSessionId !== command.workoutSessionId ||
      existingExercise.prescriptionExerciseId !== command.prescriptionExerciseId
    ) {
      return { outcome: "REJECTED", sessionId, progressionTriggerSessionId: null };
    }
  }

  const load = loadValidation.value;
  const upserted = await tx
    .insert(performedSets)
    .values({
      id: command.performedSetId,
      performedExerciseId: command.performedExerciseId,
      prescriptionSetId: command.prescriptionSetId,
      orderIndex: command.setOrder,
      actualReps: command.actualReps,
      loadKind: load.kind,
      loadAmountMilli: load.amountMilli,
      loadUnit: load.unit,
      loadBasis: load.basis,
      setType: command.setType,
      completionState: "COMPLETED",
      completedAt: new Date(command.completedAt),
      revision: command.revision,
    })
    .onConflictDoUpdate({
      target: performedSets.id,
      set: {
        actualReps: sql`excluded.actual_reps`,
        loadKind: sql`excluded.load_kind`,
        loadAmountMilli: sql`excluded.load_amount_milli`,
        loadUnit: sql`excluded.load_unit`,
        loadBasis: sql`excluded.load_basis`,
        // A recompletion may correct set type (Progression Prerequisites
        // V1 — warm-up <-> working conversion reuses this exact reopen ->
        // recomplete path, no separate command), gated by the same
        // revision rule as every other reality field here.
        setType: sql`excluded.set_type`,
        completionState: sql`excluded.completion_state`,
        completedAt: sql`excluded.completed_at`,
        revision: sql`excluded.revision`,
        updatedAt: sql`now()`,
      },
      // The revision-gated convergence (spec section 17): only apply if
      // the incoming revision is strictly newer than what's stored.
      setWhere: sql`${performedSets.revision} < excluded.revision`,
    })
    .returning({ id: performedSets.id });

  const outcome = upserted.length > 0 ? "APPLIED" : "STALE";
  return {
    outcome,
    sessionId,
    // Only a genuinely-APPLIED late correction against an ALREADY-COMPLETED
    // session schedules re-evaluation — the ordinary in-progress case
    // (session still ACTIVE) is evaluated exactly once, at FINISH.
    progressionTriggerSessionId: outcome === "APPLIED" && session.status === "COMPLETED" ? sessionId : null,
  };
}

async function applyReopenSet(
  tx: Database,
  userId: string,
  command: ReopenSetCommandV1,
): Promise<SetMutationResult> {
  const [owner] = await tx
    .select({
      userId: workoutSessions.userId,
      sessionId: workoutSessions.id,
      status: workoutSessions.status,
      finishSeq: workoutSessions.finishSeq,
    })
    .from(performedSets)
    .innerJoin(performedExercises, eq(performedExercises.id, performedSets.performedExerciseId))
    .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
    .where(eq(performedSets.id, command.performedSetId))
    .limit(1);
  if (owner === undefined || owner.userId !== userId) throw new OwnershipUnresolvedRejection(); // BOLA (spec 25)

  // Same Finish causal-boundary gate as applyCompleteSet — see there for
  // the full reasoning.
  if (owner.status === "COMPLETED" && (owner.finishSeq === null || command.sessionSeq > owner.finishSeq)) {
    return { outcome: "REJECTED", sessionId: owner.sessionId, progressionTriggerSessionId: null };
  }

  const updated = await tx
    .update(performedSets)
    .set({
      completionState: "REOPENED",
      completedAt: null,
      revision: command.revision,
      updatedAt: new Date(),
    })
    .where(
      and(eq(performedSets.id, command.performedSetId), sql`${performedSets.revision} < ${command.revision}`),
    )
    .returning({ id: performedSets.id });

  const outcome = updated.length > 0 ? "APPLIED" : "STALE";
  return {
    outcome,
    sessionId: owner.sessionId,
    // A REOPEN against an already-COMPLETED session (same causal-boundary
    // allowance) also schedules re-evaluation — its own recomplete may
    // never arrive independently as new evidence (e.g. the athlete only
    // meant to reopen), so evaluating right here as well is required, not
    // just at the eventual recomplete.
    progressionTriggerSessionId: outcome === "APPLIED" && owner.status === "COMPLETED" ? owner.sessionId : null,
  };
}

/**
 * The minimum required extension to represent workout completion (spec
 * section 25/26) — a real BOLA-checked, idempotent, one-way transition.
 * No revision counter: setting the same terminal `COMPLETED` state twice
 * (e.g. a genuine retry with a different `commandId`) converges to
 * identical canonical state by construction, and this never touches
 * `performed_exercises`/`performed_sets` (spec section 29).
 *
 * `finishSeq` (Active Workout Finish Causal Boundary Fix) is the Finish
 * causal boundary/watermark — established exactly once, by whichever
 * FINISH command first observes the session still `ACTIVE`. A second,
 * distinct FINISH command for an already-`COMPLETED` session (a genuine
 * duplicate with the same `commandId` never reaches this function at all —
 * the receipts-table short-circuit in `processWorkoutCommand` handles
 * that) is a no-op here: it must never move the already-established
 * watermark (spec section 6).
 */
async function applyFinishWorkoutSession(
  tx: Database,
  userId: string,
  command: FinishWorkoutSessionCommandV1,
): Promise<{ readonly outcome: StoredOutcome; readonly transitioned: boolean }> {
  const [session] = await tx
    .select({ userId: workoutSessions.userId, status: workoutSessions.status })
    .from(workoutSessions)
    .where(eq(workoutSessions.id, command.workoutSessionId))
    .limit(1);
  if (session === undefined || session.userId !== userId) throw new OwnershipUnresolvedRejection(); // BOLA (spec 44)

  if (session.status === "COMPLETED") {
    return { outcome: "APPLIED", transitioned: false };
  }

  await tx
    .update(workoutSessions)
    .set({
      status: "COMPLETED",
      completedAt: new Date(command.completedAt),
      finishSeq: command.finishSeq,
      updatedAt: new Date(),
    })
    .where(eq(workoutSessions.id, command.workoutSessionId));

  // Progression Evaluation Orchestration V1: this is the ONE genuine
  // ACTIVE -> COMPLETED transition for this session (the receipts-table
  // short-circuit in processWorkoutCommand already absorbs a literal
  // duplicate commandId, and the branch above absorbs a distinct-commandId
  // FINISH replay against an already-COMPLETED session) — the correct,
  // single point to schedule the durable evaluation job from.
  return { outcome: "APPLIED", transitioned: true };
}

function resourceTypeFor(command: WorkoutCommandV1): string {
  if (command.type === "START_WORKOUT_SESSION_V1" || command.type === "FINISH_WORKOUT_SESSION_V1") {
    return "WORKOUT_SESSION";
  }
  return "PERFORMED_SET";
}

function resourceIdFor(command: WorkoutCommandV1): string {
  switch (command.type) {
    case "START_WORKOUT_SESSION_V1":
    case "FINISH_WORKOUT_SESSION_V1":
      return command.workoutSessionId;
    case "COMPLETE_SET_V1":
    case "REOPEN_SET_V1":
      return command.performedSetId;
  }
}

/**
 * The ONE receipt lookup (Auth & Local Athlete Boundary V1 Slice A):
 * always keyed by the authenticated actor's `userId` + `commandId` — a
 * receipt in another user's namespace is never returned, never blocks.
 */
async function findReceipt(
  db: Database,
  userId: string,
  commandId: string,
): Promise<{ outcome: StoredOutcome } | undefined> {
  const [row] = await db
    .select({ outcome: workoutCommandReceipts.outcome })
    .from(workoutCommandReceipts)
    .where(and(eq(workoutCommandReceipts.userId, userId), eq(workoutCommandReceipts.commandId, commandId)))
    .limit(1);
  return row;
}

/**
 * A retried command whose receipt shows it was already APPLIED is
 * reported as DUPLICATE (spec section 27) — the client learns "nothing to
 * do, mark synced" without implying a fresh mutation just happened.
 * STALE/REJECTED report identically whether this is the first or a
 * retried delivery — both already mean "no further action," first time
 * or not.
 */
function toClientOutcome(receipt: { outcome: StoredOutcome }, isRetry: boolean): SyncOutcome {
  if (receipt.outcome === "APPLIED") return isRetry ? "DUPLICATE" : "APPLIED";
  return receipt.outcome;
}
