import { PgBoss } from "pg-boss";
import { assertDataEnvironment, createDatabaseClient } from "@vostivo/database";
import { createLogger } from "@vostivo/observability";
import {
  PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1,
  PROGRESSION_EVALUATE_SESSION_QUEUE_V1,
  ensureProgressionApplicationDispatchQueues,
  ensureProgressionEvaluateSessionQueues,
} from "@vostivo/progression-application";
import { loadWorkerConfig } from "./worker-config.js";
import { processProgressionEvaluateSessionJob } from "./progression-evaluate-session.job.js";
import { processProgressionApplicationDispatchJob } from "./progression-application-dispatch.job.js";

/**
 * Progression Evaluation Orchestration V1 — the worker's first real async
 * vertical slice (the prior version of this file was a heartbeat-only
 * stub explicitly deferring queue wiring until one was needed). Connects
 * to Postgres as the least-privilege `vostivo_api` role (same as
 * `apps/api`) — `{ migrate: false }`, since this process has no DDL
 * privilege and must never attempt pg-boss's own schema migrations (that
 * is `db:bootstrap-pgboss`'s job, run once with the admin role).
 *
 * `apps/worker` never imports anything from `apps/api` — every shared
 * piece (`ProgressionEvaluationService`, the queue name/payload contract)
 * comes from `@vostivo/progression-application`, and the actual
 * `evaluateAndPersist` call happens ONLY here, never inline in the API's
 * request path (spec: the athlete-facing logging path must never execute
 * progression evaluation inline).
 */
export async function startWorker(): Promise<{ stop: () => Promise<void> }> {
  const config = loadWorkerConfig();
  const logger = createLogger({ serviceName: "vostivo-worker" });

  logger.info("Vostivo worker starting", { env: config.NODE_ENV, dataEnv: config.VOSTIVO_DATA_ENV ?? "unset" });
  // Dogfood Environment V1 — refuse a declared/connected data-environment mismatch before pg-boss starts.
  await assertDataEnvironment(config.VOSTIVO_DATA_ENV, config.DATABASE_URL);

  const db = createDatabaseClient(config.DATABASE_URL);
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, migrate: false, supervise: true, schedule: false });
  await boss.start();
  // Defensive, idempotent — see ensureProgressionEvaluateSessionQueues's own
  // doc comment (mirrors apps/api's producer, which does the same at its
  // own startup, so neither process depends on start order).
  await ensureProgressionEvaluateSessionQueues(boss);
  // Progression Application V1 Slice D (task §5/§54) — a SEPARATE durable
  // queue from evaluation, registered once here; only this worker process
  // ever consumes it (task §54 — never `apps/api`).
  await ensureProgressionApplicationDispatchQueues(boss);

  boss.on("error", (error: unknown) => {
    logger.error("pg-boss reported an error", { error: error instanceof Error ? error.message : error });
  });

  await boss.work(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { batchSize: 1 }, async (jobs) => {
    const [job] = jobs;
    if (job === undefined) return;

    logger.info("progression-evaluate-session-v1: processing job", { jobId: job.id, data: job.data });
    const result = await processProgressionEvaluateSessionJob(db, boss, job.data);
    logger.info("progression-evaluate-session-v1: job complete", {
      jobId: job.id,
      workoutSessionId: result.workoutSessionId,
      evaluated: result.evaluated,
      skipped: result.skipped,
    });
  });

  await boss.work(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, { batchSize: 1 }, async (jobs) => {
    const [job] = jobs;
    if (job === undefined) return;

    logger.info("progression-application-dispatch-v1: processing job", { jobId: job.id, data: job.data });
    const result = await processProgressionApplicationDispatchJob(db, job.data);
    logger.info("progression-application-dispatch-v1: job complete", { jobId: job.id, ...result });
  });

  logger.info("Vostivo worker ready", { queues: [PROGRESSION_EVALUATE_SESSION_QUEUE_V1, PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1] });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Vostivo worker stopping");
    // Graceful: lets an in-flight job finish rather than aborting it
    // mid-handler — a half-run evaluation loop over a session's exercises
    // should still be allowed to reach its own natural completion.
    await boss.stop({ graceful: true });
    // `createDatabaseClient`'s `Database` type alias erases drizzle-orm's
    // `$client` (present on the factory's real return type, not on the
    // bare `PostgresJsDatabase` class the alias names) — the object itself
    // still carries it at runtime, so this narrow, local cast closes the
    // real underlying postgres-js connection pool cleanly on shutdown.
    await (db as unknown as { readonly $client: { end(): Promise<void> } }).$client.end();
    logger.info("Vostivo worker stopped");
  };

  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });

  return { stop };
}

if (process.env.VITEST === undefined) {
  startWorker().catch((error: unknown) => {
    console.error("Vostivo worker failed to start:", error);
    process.exitCode = 1;
  });
}
