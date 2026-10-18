import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import type { Database } from "@vostivo/database";
import { processProgressionEvaluateSessionJob } from "./progression-evaluate-session.job.js";

/**
 * A `Database` that throws if touched at all — proves the job payload is
 * validated BEFORE any database access is attempted (a malformed/tampered
 * job payload must never even reach a query), without needing a real
 * Postgres connection for this one precondition.
 */
const POISONED_DB = new Proxy(
  {},
  {
    get(): never {
      throw new Error("POISONED_DB: no database access should happen before payload validation");
    },
  },
) as Database;

/** Same reasoning as `POISONED_DB` — payload validation must also precede any pg-boss access (Slice D's own dispatch-enqueue call). */
const POISONED_BOSS = new Proxy(
  {},
  {
    get(): never {
      throw new Error("POISONED_BOSS: no pg-boss access should happen before payload validation");
    },
  },
) as PgBoss;

describe("processProgressionEvaluateSessionJob — payload validation", () => {
  it("rejects a payload missing workoutSessionId before touching the database", async () => {
    await expect(processProgressionEvaluateSessionJob(POISONED_DB, POISONED_BOSS, { triggerCommandId: "c-1" })).rejects.toThrow();
  });

  it("rejects a payload missing triggerCommandId before touching the database", async () => {
    await expect(processProgressionEvaluateSessionJob(POISONED_DB, POISONED_BOSS, { workoutSessionId: "s-1" })).rejects.toThrow();
  });

  it("rejects a completely malformed payload (e.g. null) before touching the database", async () => {
    await expect(processProgressionEvaluateSessionJob(POISONED_DB, POISONED_BOSS, null)).rejects.toThrow();
  });
});
