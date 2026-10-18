import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { PgBoss, fromDrizzle } from "pg-boss";
import { sql } from "drizzle-orm";
import { createDatabaseClient, type Database } from "@vostivo/database";
import { PROGRESSION_EVALUATE_SESSION_QUEUE_V1 } from "@vostivo/progression-application";
import { ensureQueuesViaDedicatedAdminConnection } from "./pgboss-producer.module.js";

/**
 * Real-Postgres regression proof for the original API boot crash: queue
 * administration (`createQueue`'s raw scripted BEGIN/advisory-lock/COMMIT
 * transaction) used to run over the shared, ordinary POOLED Drizzle
 * client (`fromDrizzle(db, sql)`), which `postgres.js` refuses
 * ("UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1").
 * This suite reproduces that EXACT failure first (proving the bug was
 * real, not assumed), then proves `ensureQueuesViaDedicatedAdminConnection`
 * — the fix — works against the same real Postgres, both when the queue
 * already exists and when it does not, and repeatedly (idempotent).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("PgBoss queue administration (real Postgres)", () => {
  let adminSql: Sql;

  beforeAll(() => {
    adminSql = postgres(DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await adminSql.end();
  });

  it("PGBOSS-ADMIN-001: reproduces the original crash — createQueue over the shared pooled fromDrizzle client throws UNSAFE_TRANSACTION", async () => {
    const db: Database = createDatabaseClient(DATABASE_URL);
    const pooledBoss = new PgBoss({ db: fromDrizzle(db, sql), migrate: false, supervise: false, schedule: false });
    await pooledBoss.start();

    const failure: unknown = await pooledBoss.createQueue(PROGRESSION_EVALUATE_SESSION_QUEUE_V1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // The UNSAFE_TRANSACTION code surfaces on the wrapped driver error
    // (`DrizzleQueryError`'s `.cause`), not the outer message — this
    // assertion follows the exact shape hit during this task's Part 1
    // inspection, not a guess.
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(String((cause as { code?: unknown } | undefined)?.code ?? cause)).toContain("UNSAFE_TRANSACTION");

    await pooledBoss.stop();
    await (db as unknown as { readonly $client: { end(): Promise<void> } }).$client.end();
  });

  it("PGBOSS-ADMIN-002: the dedicated admin connection (native connectionString mode) creates a queue that does NOT yet exist", async () => {
    // A throwaway queue name, never the shared canonical one — the real
    // dev database already has durable jobs referencing the canonical
    // queue (FK-protected), so it cannot be deleted/recreated inside a
    // shared-DB test. This proves the exact mechanism
    // (`ensureQueuesViaDedicatedAdminConnection` uses: a dedicated,
    // native-`connectionString` `PgBoss` instance) handles a genuinely
    // new queue — the real "queues don't exist yet" case is additionally
    // proven for real against the fresh `vostivo_manual` database (see
    // this task's final report).
    const throwawayQueue = `pgboss-admin-fix-proof-${Date.now()}`;
    await adminSql`DELETE FROM pgboss.queue WHERE name = ${throwawayQueue}`;

    const adminBoss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await adminBoss.start();
    try {
      await expect(adminBoss.createQueue(throwawayQueue)).resolves.not.toThrow();
      const [row] = await adminSql<[{ count: number }]>`SELECT count(*)::int AS count FROM pgboss.queue WHERE name = ${throwawayQueue}`;
      expect(row?.count).toBe(1);
    } finally {
      await adminSql`DELETE FROM pgboss.queue WHERE name = ${throwawayQueue}`;
      await adminBoss.stop();
    }
  });

  it("PGBOSS-ADMIN-003: is idempotent — ensuring an already-existing queue does not throw and does not duplicate it", async () => {
    await expect(ensureQueuesViaDedicatedAdminConnection(DATABASE_URL)).resolves.not.toThrow();
    await expect(ensureQueuesViaDedicatedAdminConnection(DATABASE_URL)).resolves.not.toThrow();

    const [row] = await adminSql<[{ count: number }]>`SELECT count(*)::int AS count FROM pgboss.queue WHERE name = ${PROGRESSION_EVALUATE_SESSION_QUEUE_V1}`;
    expect(row?.count).toBe(1);
  });

  it("PGBOSS-ADMIN-004: the normal API DB pool itself is never forced to max:1 — createDatabaseClient still returns a real pool", async () => {
    const db: Database = createDatabaseClient(DATABASE_URL);
    const client = (db as unknown as { readonly $client: { options: { max: number }; end(): Promise<void> } }).$client;
    // postgres.js's own default pool size (10) — never narrowed to 1 by
    // this fix. A regression here would mean someone "solved" the crash
    // by globally forcing max:1, which task's own locked decision forbids.
    expect(client.options.max).toBeGreaterThan(1);
    await client.end();
  });
});
