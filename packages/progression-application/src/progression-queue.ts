import { z } from "zod";
import { fromDrizzle, type DrizzleSqlTagLike, type DrizzleTransactionLike, type PgBoss } from "pg-boss";

/**
 * Progression Evaluation Orchestration V1 — the durable job contract
 * between `apps/api` (producer, enqueues transactionally alongside the
 * canonical mutation) and `apps/worker` (consumer, the only runtime that
 * ever calls `ProgressionEvaluationService.evaluateAndPersist`). Lives in
 * this shared package — not `apps/api` or `apps/worker` — so both sides
 * import the exact same name/schema and can never drift.
 *
 * Session-level granularity (one job per `FINISH_WORKOUT_SESSION_V1`, or
 * per post-Finish evidence-changing command on an already-COMPLETED
 * session): the worker enumerates every eligible performed exercise for
 * the session itself, rather than one job per exercise. This keeps the
 * durable trigger point exactly at the transaction boundary that actually
 * changed canonical evidence, without the producer needing to know which
 * individual exercises are progression-eligible (that classification
 * already lives entirely inside `ProgressionEvaluationService` —
 * duplicating it at the enqueue site would be exactly the kind of second
 * copy of engine-adjacent logic this task's §14 warns against).
 */
export const PROGRESSION_EVALUATE_SESSION_QUEUE_V1 = "progression-evaluate-session-v1";

/**
 * Deliberately minimal and non-sensitive (spec: "no userId trusted as
 * authority, no full snapshots"). `triggerCommandId` is carried only for
 * observability/audit correlation (which sync command caused this job to
 * be created) — the worker's own authority for `userId` and session state
 * always comes from re-reading the canonical `workout_sessions` row, never
 * from this payload (BOLA: a job payload is not a trusted caller any more
 * than an HTTP request body would be).
 */
export const progressionEvaluateSessionJobPayloadV1Schema = z.object({
  workoutSessionId: z.string(),
  triggerCommandId: z.string(),
});

export type ProgressionEvaluateSessionJobPayloadV1 = z.infer<typeof progressionEvaluateSessionJobPayloadV1Schema>;

/** Terminal (retries-exhausted) landing spot, configured on the queue itself by the pg-boss bootstrap script — never consumed automatically (a dead-letter reprocessing workflow is explicitly out of this task's scope). */
export const PROGRESSION_EVALUATE_SESSION_DEAD_LETTER_QUEUE_V1 = "progression-evaluate-session-v1-dlq";

/**
 * Shared queue configuration — one place both `apps/api`'s producer and
 * the pg-boss bootstrap script read from, so they can never drift. 8
 * retries with exponential backoff (capped at 5 minutes) comfortably rides
 * out a worker deploy/restart or a brief Postgres blip; a 5-minute
 * `expireInSeconds` is generous for one session's worth of exercises
 * (never an unbounded scan — §18's bounded evidence window applies per
 * exercise) while still failing/retrying a genuinely stuck job in
 * reasonable time.
 */
export const PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS = {
  retryLimit: 8,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 300,
  deadLetter: PROGRESSION_EVALUATE_SESSION_DEAD_LETTER_QUEUE_V1,
} as const;

/**
 * Idempotently ensures both the dead-letter queue and the main queue exist
 * (pg-boss's `createQueue` is `ON CONFLICT DO NOTHING` — safe to call on
 * every process startup, not just once via the bootstrap script). The dead
 * letter queue must be created FIRST: pg-boss's own `createQueue` refuses
 * to reference a `deadLetter` queue that does not exist yet. Both API and
 * worker processes call this defensively at startup — plain DML (an
 * `INSERT` via a function call with default `PUBLIC` `EXECUTE`), never DDL,
 * so it works fine under the least-privilege `vostivo_api` role and needs
 * no admin-role connection, unlike the pg-boss SCHEMA/table bootstrap
 * itself (see `packages/database/src/bootstrap-pgboss.ts`).
 */
export async function ensureProgressionEvaluateSessionQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(PROGRESSION_EVALUATE_SESSION_DEAD_LETTER_QUEUE_V1);
  await boss.createQueue(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS);
}

/**
 * Enqueues one progression-evaluation job for a workout session, using
 * pg-boss's first-party Drizzle adapter to redirect the actual job-insert
 * SQL into the CALLER's own transaction (`tx`) — so the job row commits or
 * rolls back atomically with the canonical mutation that triggered it,
 * never in a separate connection/transaction (spec §2/§21: "no crash
 * window between commit and job creation"). Retry/expiry/dead-letter
 * behavior is configured once on the queue itself (bootstrap script), not
 * repeated per call — a repeated late correction simply enqueues another
 * job; the worker re-derives everything fresh from canonical state on
 * every run, so redundant jobs are harmless (idempotent), never incorrect.
 *
 * `boss` must already be `.start()`ed (its own internal bookkeeping, e.g.
 * queue-existence caching, uses the instance's own connection regardless of
 * this per-call `db` override — proven empirically against real Postgres
 * during this task's Part 1 inspection). `boss.send()`'s own DB write is
 * fully redirected by the `db` option below; `boss` itself never needs to
 * be constructed with a real standalone connection pool — `fromDrizzle`
 * over the caller's ordinary (non-transactional) app `db`/`sql` works
 * equally well for that `.start()` call.
 */
export async function enqueueProgressionEvaluateSession(
  boss: PgBoss,
  tx: DrizzleTransactionLike,
  sqlTag: DrizzleSqlTagLike,
  payload: ProgressionEvaluateSessionJobPayloadV1,
): Promise<string | null> {
  const validated = progressionEvaluateSessionJobPayloadV1Schema.parse(payload);
  return boss.send(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, validated, {
    db: fromDrizzle(tx, sqlTag),
  });
}
