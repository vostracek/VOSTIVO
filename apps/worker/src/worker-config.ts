import { z } from "zod";
import { baseConfigSchema, loadConfig } from "@vostivo/config";
import { DATA_ENVIRONMENTS } from "@vostivo/database";

/**
 * Progression Evaluation Orchestration V1 — the worker's first real
 * dependency on a database connection (the prior heartbeat-only stub had
 * none). `DATABASE_URL` is always the least-privilege API RUNTIME role's
 * connection string (same convention as `packages/database/src/config.ts`'s
 * `databaseConfigSchema` — the worker is an ordinary runtime consumer, not
 * a migration tool, so it never reads `MIGRATION_DATABASE_URL`).
 */
export const workerConfigSchema = baseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  // Dogfood Environment V1 — same meaning and guard as apps/api's config.
  VOSTIVO_DATA_ENV: z.enum(DATA_ENVIRONMENTS).optional(),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(source: Record<string, string | undefined> = process.env): WorkerConfig {
  return loadConfig(workerConfigSchema, source);
}
