import { eq } from "drizzle-orm";
import { athleteProfiles, progressionDecisions, type Database } from "@vostivo/database";
import {
  applySystemProgression,
  ensureApplicationForDecision,
  progressionApplicationDispatchJobPayloadV1Schema,
  resolveProgressionAuthority,
  type ApplyOutcome,
} from "@vostivo/progression-application";
import { createLogger } from "@vostivo/observability";

const logger = createLogger({ serviceName: "vostivo-worker-progression-application-dispatch" });

export type ProgressionApplicationDispatchJobResult =
  | { readonly status: "DECISION_NOT_FOUND" }
  | { readonly status: "NO_APPLICATION"; readonly reason: string }
  | { readonly status: "LEFT_FOR_ATHLETE_REVIEW"; readonly applicationId: string }
  | { readonly status: "ALREADY_DECIDED"; readonly applicationId: string }
  | { readonly status: "SYSTEM_APPLY_ATTEMPTED"; readonly applicationId: string; readonly outcome: ApplyOutcome["status"]; readonly reason?: string };

/**
 * Progression Application V1 — Slice D (task §5/§9/§10/§19) — the ONLY
 * place that ever calls `applySystemProgression`. Processes exactly one
 * `progression-application-dispatch-v1` job: idempotently ensures the
 * workflow exists (task §9), then re-derives current canonical mode
 * authority FRESH from `athlete_profiles` (task §2/§4 — never trusted
 * from the job payload, the `EngineDecision`'s own normalized input, or
 * any `progression_applications` field; "current mode wins," never a
 * mode snapshotted at decision-creation time).
 *
 * Worker stays thin (task §51): this handler contains no mode SQL beyond
 * the one canonical read, no `LoadingCapability` SQL, no numeric-resolver
 * math — all of that lives in `@vostivo/progression-application`, exactly
 * as `processProgressionEvaluateSessionJob` already delegates to
 * `ProgressionEvaluationService`.
 *
 * Domain outcomes (task §8/§17/§18) — an application that is not
 * currently `INCREASE_LOAD`/Plan-backed, already decided, `STALE`/
 * `SUPERSEDED`, or mechanically un-appliable (missing capability, etc.) —
 * are all durable, expected RESULTS: the job completes normally, never
 * throws, never retries. Only a genuinely thrown DB/infra error (a real
 * transient failure) propagates uncaught to pg-boss's own retry/backoff.
 */
export async function processProgressionApplicationDispatchJob(
  db: Database,
  rawPayload: unknown,
): Promise<ProgressionApplicationDispatchJobResult> {
  const payload = progressionApplicationDispatchJobPayloadV1Schema.parse(rawPayload);

  const [decision] = await db
    .select({ userId: progressionDecisions.userId })
    .from(progressionDecisions)
    .where(eq(progressionDecisions.id, payload.progressionDecisionId))
    .limit(1);

  if (decision === undefined) {
    // Structurally shouldn't happen — progression_decisions rows are
    // immutable and never deleted — but never crash/retry-storm on it.
    logger.warn("progression_decisions row not found for dispatch job — skipping, no action possible", {
      progressionDecisionId: payload.progressionDecisionId,
    });
    return { status: "DECISION_NOT_FOUND" };
  }

  // Task §9: idempotently ensure the workflow exists first (only a
  // current, Plan-backed INCREASE_LOAD decision ever produces one — task
  // §6). Actor derivation matches `ProgressionEvaluationService`'s own
  // precedent: the decision's own canonical `userId`, never trusted from
  // anywhere else.
  const ensured = await ensureApplicationForDecision(db, { userId: decision.userId }, payload.progressionDecisionId);
  if (ensured.status !== "CREATED" && ensured.status !== "ALREADY_EXISTS") {
    logger.info("no progression application workflow for this decision — nothing to dispatch", {
      progressionDecisionId: payload.progressionDecisionId,
      reason: ensured.status,
    });
    return { status: "NO_APPLICATION", reason: ensured.status };
  }
  const application = ensured.application;

  if (application.status !== "PENDING_REVIEW") {
    // Already decided by a previous dispatch attempt (duplicate job — task
    // §7/§32), or independently transitioned (STALE/SUPERSEDED/KEPT_ORIGINAL)
    // — nothing left to do, converges safely.
    return { status: "ALREADY_DECIDED", applicationId: application.id };
  }

  // Task §2/§4: canonical mode, re-read fresh at the moment authority is
  // evaluated — never the mode at decision-creation time.
  const [athleteRow] = await db
    .select({ experienceMode: athleteProfiles.experienceMode })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, decision.userId))
    .limit(1);

  if (athleteRow === undefined) {
    // Structurally shouldn't happen (every user with progression evidence
    // has an athlete profile) — the safe default is to leave the
    // application exactly as it is (PENDING_REVIEW), never guess.
    logger.warn("athlete_profiles row not found while resolving progression authority — leaving application PENDING_REVIEW", {
      progressionDecisionId: payload.progressionDecisionId,
      applicationId: application.id,
    });
    return { status: "LEFT_FOR_ATHLETE_REVIEW", applicationId: application.id };
  }

  const authority = resolveProgressionAuthority({ experienceMode: athleteRow.experienceMode });

  if (authority === "ATHLETE_REVIEW") {
    // Task §19: ADAPTIVE/EXPERT — ensure only, never auto-apply.
    return { status: "LEFT_FOR_ATHLETE_REVIEW", applicationId: application.id };
  }

  // GUIDED — task §10/§11.
  const applyOutcome = await applySystemProgression(db, { applicationId: application.id, systemCommandId: payload.systemCommandId });

  logger.info("progression-application-dispatch-v1: GUIDED system apply attempted", {
    progressionDecisionId: payload.progressionDecisionId,
    applicationId: application.id,
    outcome: applyOutcome.status,
    reason: applyOutcome.status === "NOT_APPLIED" ? applyOutcome.reason : undefined,
  });

  return {
    status: "SYSTEM_APPLY_ATTEMPTED",
    applicationId: application.id,
    outcome: applyOutcome.status,
    ...(applyOutcome.status === "NOT_APPLIED" ? { reason: applyOutcome.reason } : {}),
  };
}
