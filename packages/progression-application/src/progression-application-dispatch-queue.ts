import { z } from "zod";
import type { PgBoss } from "pg-boss";

/**
 * Progression Application V1 — Slice D (task §5) — the durable job
 * contract between `apps/worker`'s own `progression-evaluate-session-v1`
 * consumer (which now ALSO acts as this queue's producer, immediately
 * after persisting an `INCREASE_LOAD` `EngineDecision`) and this SEPARATE
 * queue's own consumer. Deliberately a distinct queue from
 * `progression-evaluate-session-v1` (task §5's own hard rule: "the
 * evaluation worker must never directly mutate the effective Plan") —
 * evaluation success and application-dispatch success are two different
 * facts, exactly as `progression_decisions` and `progression_applications`
 * are two different tables.
 */
export const PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1 = "progression-application-dispatch-v1";

/**
 * Minimal payload (task §5's own "payload minimum"): `progressionDecisionId`
 * is the only real authority this job needs — every other fact (owner,
 * Plan slot, current mode) is re-derived fresh from canonical Postgres
 * state when the job runs (task §2/§48 — a job payload is not a trusted
 * caller any more than an HTTP request body). `systemCommandId` is
 * generated once at ENQUEUE time (task §15) and is stable across pg-boss
 * retries of this exact durable job instance, since it lives inside the
 * persisted job payload itself — never regenerated per attempt, and never
 * relied on for correctness *across* independently-enqueued duplicate
 * dispatch jobs (task §15's own explicit warning; the real idempotency
 * guard is `progression_applications`' own `UNIQUE(progression_decision_id)`
 * plus the state-machine/command-receipt invariants already proven in
 * Slice B/C).
 */
export const progressionApplicationDispatchJobPayloadV1Schema = z.object({
  progressionDecisionId: z.string(),
  systemCommandId: z.string(),
});

export type ProgressionApplicationDispatchJobPayloadV1 = z.infer<typeof progressionApplicationDispatchJobPayloadV1Schema>;

/** Terminal (retries-exhausted) landing spot — never consumed automatically, same convention as `progression-evaluate-session-v1`'s own dead-letter queue. */
export const PROGRESSION_APPLICATION_DISPATCH_DEAD_LETTER_QUEUE_V1 = "progression-application-dispatch-v1-dlq";

/**
 * Task §8's transient-vs-domain retry split: 8 retries with exponential
 * backoff (identical shape to `PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS`
 * — this codebase's own established convention, not a new policy)
 * comfortably rides out a worker deploy/restart or a brief Postgres blip.
 * A genuine domain outcome (`LOADING_CAPABILITY_UNAVAILABLE`, `STALE`,
 * already-terminal, ...) is never thrown — the job handler returns a
 * normal durable result and pg-boss marks it complete on the first
 * attempt, so this retry/backoff configuration is only ever exercised by
 * a real transient/infrastructure failure, never a "physically impossible
 * progression" (task §8's explicit "do not retry a physically impossible
 * progression every few seconds").
 */
export const PROGRESSION_APPLICATION_DISPATCH_QUEUE_OPTIONS = {
  retryLimit: 8,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 300,
  deadLetter: PROGRESSION_APPLICATION_DISPATCH_DEAD_LETTER_QUEUE_V1,
} as const;

/** Idempotent — safe to call on every process startup (mirrors `ensureProgressionEvaluateSessionQueues`'s own doc comment/reasoning exactly). */
export async function ensureProgressionApplicationDispatchQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(PROGRESSION_APPLICATION_DISPATCH_DEAD_LETTER_QUEUE_V1);
  await boss.createQueue(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, PROGRESSION_APPLICATION_DISPATCH_QUEUE_OPTIONS);
}

/**
 * Task §7/§31: enqueued AFTER the `EngineDecision` has already committed
 * (unlike `enqueueProgressionEvaluateSession`'s same-transaction
 * `fromDrizzle` redirect, there is no ambient transaction to participate
 * in here — the decision's own persist transaction already committed by
 * the time the evaluate-session job handler reaches this call). The
 * resulting crash window (decision committed, dispatch not yet enqueued)
 * is closed by job-level retry, not statement-level atomicity: if the
 * evaluate-session job crashes before returning success, pg-boss retries
 * the WHOLE job, which idempotently re-finds the same decision
 * (`evaluateAndPersist`'s own fingerprint-based idempotency) and reaches
 * this enqueue call again (task §7 scenario A). Duplicates are explicitly
 * allowed (task §7) — never build a distributed transaction to avoid one.
 */
export async function enqueueProgressionApplicationDispatch(
  boss: PgBoss,
  payload: ProgressionApplicationDispatchJobPayloadV1,
): Promise<string | null> {
  const validated = progressionApplicationDispatchJobPayloadV1Schema.parse(payload);
  return boss.send(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, validated);
}
