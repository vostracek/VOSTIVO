import { Global, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { Database } from "@vostivo/database";
import { ensureProgressionEvaluateSessionQueues } from "@vostivo/progression-application";
import type { ApiConfig } from "../common/config/api-config.js";
import { DATABASE } from "../database/database.module.js";

export const PGBOSS_PRODUCER = Symbol("PGBOSS_PRODUCER");

/**
 * Queue administration (`createQueue`, called by
 * `ensureProgressionEvaluateSessionQueues`) runs a raw, manually-scripted
 * multi-statement transaction (`BEGIN; ...advisory lock...; SELECT
 * pgboss.create_queue(...); COMMIT;`). `postgres.js` refuses to run that
 * over a connection drawn from an ordinary pool — "Only use sql.begin,
 * sql.reserved or max: 1" — because the pool is free to route each
 * statement to a different physical connection. This is exactly the crash
 * that was previously hit by reusing the transactional producer's
 * `fromDrizzle(db, sql)`-wrapped pooled client for queue administration.
 *
 * Fix: a SEPARATE, short-lived `PgBoss` instance, constructed with pg-boss's
 * own native `{ connectionString }` mode (the same mode `apps/worker` and
 * `db:bootstrap-pgboss` already use successfully) — pg-boss manages that
 * connection itself and can correctly reserve one for a scripted
 * transaction. It exists only long enough to ensure the queue, then is
 * stopped; it is never exposed via `PGBOSS_PRODUCER` and never reused for
 * `.send()`.
 *
 * One source of truth for queue names/options: imports
 * `ensureProgressionEvaluateSessionQueues` from
 * `@vostivo/progression-application` rather than duplicating the queue
 * name here.
 */
export async function ensureQueuesViaDedicatedAdminConnection(databaseUrl: string): Promise<void> {
  const adminBoss = new PgBoss({ connectionString: databaseUrl, migrate: false, supervise: false, schedule: false });
  await adminBoss.start();
  try {
    await ensureProgressionEvaluateSessionQueues(adminBoss);
  } finally {
    await adminBoss.stop();
  }
}

/**
 * Progression Evaluation Orchestration V1 — the API-side pg-boss producer.
 * `apps/api` only ever ENQUEUES jobs (inside the same transaction as the
 * canonical mutation that triggers them, via `enqueueProgressionEvaluateSession`
 * in `@vostivo/progression-application`); it never processes them —
 * `apps/worker` is the only runtime that calls
 * `ProgressionEvaluationService.evaluateAndPersist`.
 *
 * `{ migrate: false, supervise: false, schedule: false }`: this instance
 * must never run pg-boss's own DDL migrations (that's the dedicated
 * `db:bootstrap-pgboss` admin-role script's job — this instance connects
 * with the least-privilege `vostivo_api` role, which has no CREATE
 * privilege at all) or any background maintenance/cron loop the API
 * process has no business running. `migrate: false` makes `.start()` take
 * pg-boss's read-only `.check()` path instead — safe under a DML-only role.
 *
 * Constructed with `{ db: fromDrizzle(db, sql) }` — the app's own ordinary
 * (non-transactional, REAL pooled) Drizzle client, deliberately never
 * forced to `max: 1` globally (the pool continues to serve every other
 * ordinary query in the app). `.start()`'s own internal bookkeeping only
 * needs A working connection, which this client provides fine. Every
 * actual job insert still goes through a PER-CALL `db` override bound to
 * the CALLER's own transaction (`enqueueProgressionEvaluateSession`) —
 * this instance-level `db` is never used for that, and (after the fix
 * below) never used for queue administration either.
 */
@Injectable()
class PgBossProducerService implements OnModuleInit, OnModuleDestroy {
  readonly boss: PgBoss;

  constructor(
    @Inject(DATABASE) db: Database,
    private readonly configService: ConfigService<ApiConfig, true>,
  ) {
    this.boss = new PgBoss({ db: fromDrizzle(db, sql), migrate: false, supervise: false, schedule: false });
  }

  async onModuleInit(): Promise<void> {
    // Queue administration happens FIRST, over its own dedicated
    // connection — before the transactional producer starts accepting
    // work, so a `.send()` can never race a queue that doesn't exist yet.
    await ensureQueuesViaDedicatedAdminConnection(this.configService.get("DATABASE_URL", { infer: true }));
    await this.boss.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }
}

@Global()
@Module({
  providers: [
    PgBossProducerService,
    {
      provide: PGBOSS_PRODUCER,
      useFactory: (service: PgBossProducerService): PgBoss => service.boss,
      inject: [PgBossProducerService],
    },
  ],
  exports: [PGBOSS_PRODUCER],
})
export class PgBossProducerModule {}
