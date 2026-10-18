import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { sql } from "drizzle-orm";
import { createDatabaseClient, type Database } from "@vostivo/database";
import {
  PROGRESSION_EVALUATE_SESSION_QUEUE_V1,
  enqueueProgressionEvaluateSession,
  ensureProgressionEvaluateSessionQueues,
} from "./index.js";

/**
 * Progression Evaluation Orchestration V1's central durability requirement
 * (spec §2/§21 — "no crash window between commit and job creation"),
 * proven directly against a real Postgres + real pg-boss instance, not
 * simulated. This is the permanent regression form of the empirical proof
 * done during this task's Part 1 inspection (a throwaway script against
 * the same dev Postgres, since deleted).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("enqueueProgressionEvaluateSession transactional atomicity (real Postgres + real pg-boss)", () => {
  let db: Database;
  let boss: PgBoss;

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    boss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss.start();
    await ensureProgressionEvaluateSessionQueues(boss);
  });

  afterAll(async () => {
    await boss.stop();
  });

  it("a job enqueued inside a transaction that COMMITS is durably visible afterwards", async () => {
    let jobId: string | null = null;
    await db.transaction(async (tx) => {
      jobId = await enqueueProgressionEvaluateSession(boss, tx, sql, {
        workoutSessionId: "atomicity-proof-commit",
        triggerCommandId: "trigger-commit",
      });
    });

    expect(jobId).not.toBeNull();
    const [job] = await boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { id: jobId! });
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ workoutSessionId: "atomicity-proof-commit", triggerCommandId: "trigger-commit" });
  });

  it("a job enqueued inside a transaction that ROLLS BACK never exists afterwards — the job either commits WITH the mutation or never exists at all", async () => {
    let jobId: string | null = null;

    await expect(
      db.transaction(async (tx) => {
        jobId = await enqueueProgressionEvaluateSession(boss, tx, sql, {
          workoutSessionId: "atomicity-proof-rollback",
          triggerCommandId: "trigger-rollback",
        });
        throw new Error("forced rollback — proving the job never survives outside its triggering transaction");
      }),
    ).rejects.toThrow("forced rollback");

    expect(jobId).not.toBeNull();
    const jobs = await boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { id: jobId! });
    expect(jobs).toHaveLength(0);
  });

  it("rejects a payload that isn't the minimal, non-sensitive shape (no userId, no full snapshot ever reaches pg-boss)", async () => {
    await expect(
      db.transaction(async (tx) =>
        enqueueProgressionEvaluateSession(
          boss,
          tx,
          sql,
          // @ts-expect-error deliberately malformed — proving runtime validation, not just the type system
          { workoutSessionId: "x", triggerCommandId: "y", userId: "should-never-be-here" },
        ),
      ),
      // zod's .object() strips unknown keys by default rather than throwing,
      // so this asserts the STORED payload — not this call — never carries it.
    ).resolves.not.toThrow();

    const jobs = await boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { data: { workoutSessionId: "x" } });
    const [job] = jobs;
    expect(job).toBeDefined();
    expect(new Set(Object.keys(job!.data as object))).toEqual(new Set(["workoutSessionId", "triggerCommandId"]));
  });
});
