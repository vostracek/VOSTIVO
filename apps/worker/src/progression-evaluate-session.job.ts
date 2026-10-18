import { asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { performedExercises, workoutSessions, type Database } from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import {
  ProgressionEvaluationService,
  WorkoutHistoryService,
  enqueueProgressionApplicationDispatch,
  progressionEvaluateSessionJobPayloadV1Schema,
} from "@vostivo/progression-application";
import { createLogger } from "@vostivo/observability";

const logger = createLogger({ serviceName: "vostivo-worker-progression-evaluate-session" });

export interface ProgressionEvaluateSessionJobResult {
  readonly workoutSessionId: string;
  /** Exercises for which a decision was persisted (including a `NO_CHANGE`/`INSUFFICIENT_EVIDENCE` one — persisted is persisted). */
  readonly evaluated: number;
  /** Exercises skipped for a known, non-retryable reason — never a count of failures still worth retrying. */
  readonly skipped: number;
}

/**
 * Progression Evaluation Orchestration V1 — the ONLY place in this
 * codebase that calls `ProgressionEvaluationService.evaluateAndPersist`
 * (spec: the athlete-facing logging path in `apps/api` never evaluates
 * progression inline). Processes exactly one `progression-evaluate-session-v1`
 * job: re-derives the session and every one of its performed exercises
 * fresh from canonical Postgres state, then evaluates each in turn —
 * session-level granularity (spec §14/§16), never one job per exercise.
 *
 * The job PAYLOAD (`{workoutSessionId, triggerCommandId}`) is never trusted
 * as an authority for anything beyond "which session to look at" — `userId`
 * always comes from the canonical `workout_sessions` row read here, exactly
 * the same BOLA discipline `ProgressionEvaluationService`'s own existing
 * callers already apply to an `AuthenticatedActor` (spec §9/§38: a job
 * payload is not a trusted caller any more than an HTTP request body).
 *
 * Any THROWN exception here (a genuine DB/infra failure) propagates
 * uncaught to pg-boss, which fails/retries the job per the queue's
 * configured backoff (`PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS`) — never
 * swallowed. A known, structurally-expected per-exercise OUTCOME
 * (`NO_PRESCRIPTION_CONTEXT`, `ENGINE_VALIDATION_FAILED`, or a
 * `SOURCE_NOT_FOUND`/`SOURCE_SESSION_NOT_COMPLETED` race that should be
 * impossible given the precondition checks below, since the enqueueing
 * transaction only ever schedules this job for a session it just observed
 * transition to, or already, `COMPLETED`) is logged and skipped — never
 * retried (retrying identical evidence reproduces the identical outcome),
 * and never fails the whole job (each exercise's evaluation is independent
 * — one exercise's non-retryable outcome must never block another
 * exercise's PERSISTED decision in the same session).
 *
 * Progression Application V1 Slice D (task §5/§6/§31): for every
 * PERSISTED decision whose current `decisionType === 'INCREASE_LOAD'`,
 * enqueues a SEPARATE `progression-application-dispatch-v1` job — the
 * evaluation worker itself never mutates the effective Plan (task §5's
 * hard rule). Enqueued for both a newly-created AND an idempotently
 * re-retrieved decision (never only "new" — task §7 scenario A's crash-gap
 * closure depends on a retried evaluation job reaching this enqueue call
 * again for the SAME decision). `NO_CHANGE`/`MAINTAIN_LOAD_BUILD_REPS`
 * never enqueue anything (task §6) — no inert workflow is manufactured.
 */
export async function processProgressionEvaluateSessionJob(
  db: Database,
  boss: PgBoss,
  rawPayload: unknown,
): Promise<ProgressionEvaluateSessionJobResult> {
  const payload = progressionEvaluateSessionJobPayloadV1Schema.parse(rawPayload);

  const [session] = await db
    .select({ id: workoutSessions.id, userId: workoutSessions.userId, status: workoutSessions.status })
    .from(workoutSessions)
    .where(eq(workoutSessions.id, payload.workoutSessionId))
    .limit(1);

  if (session === undefined) {
    logger.warn("session not found for progression-evaluate-session-v1 job — skipping, no action possible", {
      workoutSessionId: payload.workoutSessionId,
      triggerCommandId: payload.triggerCommandId,
    });
    return { workoutSessionId: payload.workoutSessionId, evaluated: 0, skipped: 0 };
  }

  if (session.status !== "COMPLETED") {
    logger.warn(
      "session is not COMPLETED for a progression-evaluate-session-v1 job — skipping (should be structurally impossible: this job is only ever enqueued inside the same transaction that observes the session transition to, or already, COMPLETED)",
      { workoutSessionId: payload.workoutSessionId, status: session.status },
    );
    return { workoutSessionId: payload.workoutSessionId, evaluated: 0, skipped: 0 };
  }

  const exercises = await db
    .select({ id: performedExercises.id })
    .from(performedExercises)
    .where(eq(performedExercises.workoutSessionId, payload.workoutSessionId))
    .orderBy(asc(performedExercises.orderIndex));

  const historyService = new WorkoutHistoryService(db);
  const service = new ProgressionEvaluationService(db, historyService);

  let evaluated = 0;
  let skipped = 0;

  for (const exercise of exercises) {
    const outcome = await service.evaluateAndPersist(
      { userId: session.userId },
      { workoutSessionId: payload.workoutSessionId, performedExerciseId: exercise.id },
    );

    switch (outcome.status) {
      case "PERSISTED":
        evaluated += 1;
        if (outcome.decision.data.decisionType === "INCREASE_LOAD") {
          await enqueueProgressionApplicationDispatch(boss, {
            progressionDecisionId: outcome.decision.id,
            systemCommandId: createEntityId(),
          });
        }
        break;
      case "NO_PRESCRIPTION_CONTEXT":
        skipped += 1;
        break;
      case "ENGINE_VALIDATION_FAILED":
        skipped += 1;
        logger.warn("engine validation failed for one performed exercise — skipped, not retried, no fabricated recommendation", {
          workoutSessionId: payload.workoutSessionId,
          performedExerciseId: exercise.id,
          reason: outcome.reason,
        });
        break;
      case "NOT_CANONICAL_OCCURRENCE_SESSION":
        // Deliberate, final skip (Planned Workout Occurrence Authority V1):
        // the job completes normally, it is never retried.
        skipped += 1;
        logger.info("progression skipped: session is a SECONDARY session of a claimed planned occurrence", {
          workoutSessionId: payload.workoutSessionId,
          performedExerciseId: exercise.id,
        });
        break;
      case "TEMPORARY_SUBSTITUTION_NOT_EVALUATED":
        // Deliberate, final skip (Temporary Equipment Adaptation V1 Slice C):
        // a substitute never counts as the authored exercise's progression.
        skipped += 1;
        logger.info("progression skipped: exercise was a temporary equipment substitute", {
          workoutSessionId: payload.workoutSessionId,
          performedExerciseId: exercise.id,
        });
        break;
      case "SOURCE_NOT_FOUND":
      case "SOURCE_SESSION_NOT_COMPLETED":
        skipped += 1;
        logger.warn("unexpected precondition failure for one performed exercise (should be structurally impossible) — skipped, not retried", {
          workoutSessionId: payload.workoutSessionId,
          performedExerciseId: exercise.id,
          status: outcome.status,
        });
        break;
    }
  }

  return { workoutSessionId: payload.workoutSessionId, evaluated, skipped };
}
