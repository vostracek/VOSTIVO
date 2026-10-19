import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createEntityId } from "@vostivo/domain";

/**
 * Auth & Local Athlete Boundary V1 Slice A — the owner-scoped idempotency
 * migrations (0021 workout command receipts, 0022 progression application
 * commands) each proven from the PREVIOUS schema state, on a throwaway
 * database (never vostivo_dev / vostivo_manual): migrate up to just before
 * the target, write pre-migration rows exactly as the old code did, apply
 * the target through the normal drizzle migrator (twice — repeat-safe),
 * then verify rows, ownership, the new key and that nothing else changed.
 */
const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? "postgres://vostivo:vostivo@localhost:5432/vostivo_dev";
const MIGRATIONS_DIR = new URL("../../../../packages/database/drizzle/", import.meta.url).pathname;

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

/** A copy of the migrations folder whose journal stops just before `exclusiveTagPrefix`. */
function migrationsFolderBefore(root: string, exclusiveTagPrefix: string): string {
  const folder = join(root, `before-${exclusiveTagPrefix}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const entries = journal.entries.filter((entry) => entry.tag < exclusiveTagPrefix);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql") && file < exclusiveTagPrefix)) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(folder, name));
  }
  return folder;
}

/** Every constraint/index/column outside `excludedTables` — must be identical before and after the target migration. */
async function schemaFingerprintExcluding(sql: postgres.Sql, excludedTables: readonly string[]): Promise<string> {
  const excluded = [...excludedTables];
  const constraints = await sql`
    SELECT rel.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'app' AND rel.relname <> ALL(${excluded}) ORDER BY 1, 2`;
  const indexes = await sql`
    SELECT tablename AS table, indexname AS name, indexdef AS def FROM pg_indexes
    WHERE schemaname = 'app' AND tablename <> ALL(${excluded}) ORDER BY 1, 2`;
  const columns = await sql`
    SELECT table_name AS table, column_name AS name, data_type || ':' || is_nullable AS def FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name <> ALL(${excluded}) ORDER BY 1, 2`;
  return JSON.stringify([constraints, indexes, columns]);
}

async function appliedMigrationCount(sql: postgres.Sql): Promise<number> {
  const [row] = (await sql`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`) as unknown as [{ applied: number }];
  return row.applied;
}

async function constraintDef(sql: postgres.Sql, name: string): Promise<string | undefined> {
  const [row] = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`;
  return row?.def as string | undefined;
}

describe("owner-scoped idempotency migrations (scratch real Postgres)", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  /** A fresh scratch database migrated to the state just before `targetTagPrefix`. */
  async function scratchBefore(targetTagPrefix: string): Promise<{ readonly sql: postgres.Sql; readonly through: (exclusiveTagPrefix: string) => string }> {
    const name = `vostivo_idem_mig_${process.pid}_${Date.now()}_${targetTagPrefix.replace(/\W/g, "")}`;
    const admin = postgres(MIGRATION_DATABASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(MIGRATION_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const root = mkdtempSync(join(tmpdir(), "vostivo-idem-mig-"));
    cleanups.push(async () => {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    });
    await migrate(drizzle(sql), { migrationsFolder: migrationsFolderBefore(root, targetTagPrefix) });
    return { sql, through: (exclusiveTagPrefix) => migrationsFolderBefore(root, exclusiveTagPrefix) };
  }

  it("MIG-RCPT-001 (0021): preserves every pre-migration workout receipt with its original owner, enables per-owner command ids, keeps same-owner uniqueness, is repeat-safe and touches nothing else", async () => {
    const { sql, through } = await scratchBefore("0021_");
    expect(await constraintDef(sql, "workout_command_receipts_pkey")).toBe("PRIMARY KEY (command_id)");

    // Pre-migration rows exactly as the old processor wrote them: user_id =
    // the submitting actor — including a BOLA-style REJECTED attempt by B
    // carrying a command id that A will use later (the poisoning case).
    const userA = createEntityId();
    const userB = createEntityId();
    const sessionA = createEntityId();
    await sql`INSERT INTO app.users (id, status) VALUES (${userA}, 'ACTIVE'), (${userB}, 'ACTIVE')`;
    const rows = [
      { commandId: createEntityId(), userId: userA, type: "START_WORKOUT_SESSION_V1", outcome: "APPLIED", sessionId: null, seq: null },
      { commandId: createEntityId(), userId: userA, type: "COMPLETE_SET_V1", outcome: "APPLIED", sessionId: sessionA, seq: 1 },
      { commandId: createEntityId(), userId: userB, type: "COMPLETE_SET_V1", outcome: "REJECTED", sessionId: null, seq: null },
    ];
    for (const row of rows) {
      await sql`INSERT INTO app.workout_command_receipts (command_id, command_type, schema_version, user_id, outcome, workout_session_id, session_seq)
                VALUES (${row.commandId}, ${row.type}, 1, ${row.userId}, ${row.outcome}, ${row.sessionId}, ${row.seq})`;
    }
    const poisoned = rows[2]!.commandId;
    // Old key: A could never get its own receipt for the id B already used.
    await expect(sql`INSERT INTO app.workout_command_receipts (command_id, command_type, schema_version, user_id, outcome) VALUES (${poisoned}, 'COMPLETE_SET_V1', 1, ${userA}, 'APPLIED')`).rejects.toThrow();

    const snapshotBefore = await sql`SELECT * FROM app.workout_command_receipts ORDER BY command_id`;
    const otherBefore = await schemaFingerprintExcluding(sql, ["workout_command_receipts"]);
    const appliedBefore = await appliedMigrationCount(sql);

    // Apply 0021 (only) through the NORMAL migrator, then again (repeat-safe no-op).
    await migrate(drizzle(sql), { migrationsFolder: through("0022_") });
    await migrate(drizzle(sql), { migrationsFolder: through("0022_") });

    expect(await constraintDef(sql, "workout_command_receipts_pkey")).toBe("PRIMARY KEY (user_id, command_id)");
    expect(await appliedMigrationCount(sql)).toBe(appliedBefore + 1);

    // Every row preserved verbatim — nothing reassigned, backfilled or deleted.
    expect(await sql`SELECT * FROM app.workout_command_receipts ORDER BY command_id`).toEqual(snapshotBefore);
    expect(await schemaFingerprintExcluding(sql, ["workout_command_receipts"])).toBe(otherBefore);

    // New key: A now owns its own namespace for the id B used…
    await sql`INSERT INTO app.workout_command_receipts (command_id, command_type, schema_version, user_id, outcome) VALUES (${poisoned}, 'COMPLETE_SET_V1', 1, ${userA}, 'APPLIED')`;
    const shared = await sql`SELECT user_id, outcome FROM app.workout_command_receipts WHERE command_id = ${poisoned} ORDER BY outcome`;
    expect(shared.map((row) => [row.user_id as string, row.outcome as string])).toEqual([[userA, "APPLIED"], [userB, "REJECTED"]]);
    // …while the same owner still cannot record one command twice.
    await expect(sql`INSERT INTO app.workout_command_receipts (command_id, command_type, schema_version, user_id, outcome) VALUES (${poisoned}, 'COMPLETE_SET_V1', 1, ${userA}, 'APPLIED')`).rejects.toThrow();
    // The (session, sessionSeq) causal-boundary uniqueness is unchanged.
    await expect(sql`INSERT INTO app.workout_command_receipts (command_id, command_type, schema_version, user_id, outcome, workout_session_id, session_seq) VALUES (${createEntityId()}, 'COMPLETE_SET_V1', 1, ${userA}, 'APPLIED', ${sessionA}, 1)`).rejects.toThrow();
  });

  it("MIG-RCPT-002 (0022): every pre-migration progression command keeps its actor columns and gets its owner from its own application (never guessed); per-owner command ids, same-owner uniqueness, owner integrity, repeat-safe, nothing else changed", async () => {
    const { sql, through } = await scratchBefore("0022_");
    expect(await constraintDef(sql, "progression_application_commands_pkey")).toBe("PRIMARY KEY (command_id)");

    // Minimal real pre-migration fixture: two athletes, one application each.
    async function athleteWithApplication(): Promise<{ readonly userId: string; readonly applicationId: string }> {
      const userId = createEntityId();
      const profileId = createEntityId();
      const programId = createEntityId();
      const versionId = createEntityId();
      const blockId = createEntityId();
      const sessionId = createEntityId();
      const performedExerciseId = createEntityId();
      const decisionId = createEntityId();
      const applicationId = createEntityId();
      await sql`INSERT INTO app.users (id, status) VALUES (${userId}, 'ACTIVE')`;
      await sql`INSERT INTO app.athlete_profiles (id, user_id, experience_mode, unit_system) VALUES (${profileId}, ${userId}, 'GUIDED', 'METRIC')`;
      await sql`INSERT INTO app.programs (id, athlete_profile_id, name, status) VALUES (${programId}, ${profileId}, 'P', 'ACTIVE')`;
      await sql`INSERT INTO app.program_versions (id, program_id, version_number, status, activated_at) VALUES (${versionId}, ${programId}, 1, 'ACTIVE', now())`;
      await sql`INSERT INTO app.training_blocks (id, program_version_id, name, goal, order_index, cycle_count, focus_areas) VALUES (${blockId}, ${versionId}, 'B', 'Hypertrophy', 1, 1, '[]'::jsonb)`;
      await sql`INSERT INTO app.workout_sessions (id, user_id, prescription_snapshot, started_at, status) VALUES (${sessionId}, ${userId}, '{}'::jsonb, now(), 'COMPLETED')`;
      await sql`INSERT INTO app.performed_exercises (id, workout_session_id, exercise_ref, display_name, order_index) VALUES (${performedExerciseId}, ${sessionId}, 'bench-press', 'Bench Press', 1)`;
      await sql`INSERT INTO app.progression_decisions (id, user_id, exercise_ref, source_workout_session_id, source_performed_exercise_id, source_prescription_exercise_id, engine, policy, decision_type, reason_code, evidence_strength, progression_stalled, normalized_input_snapshot, evidence_refs, evidence_fingerprint)
                VALUES (${decisionId}, ${userId}, 'bench-press', ${sessionId}, ${performedExerciseId}, 'slot', 'progression', 'v1', 'INCREASE_LOAD', 'TOP_OF_RANGE_ACHIEVED', 'SUPPORTED', false, '{}'::jsonb, '[]'::jsonb, ${createEntityId()})`;
      await sql`INSERT INTO app.progression_applications (id, progression_decision_id, user_id, exercise_ref, program_version_id, training_block_id, workout_order_index, exercise_order_index, effective_from_cycle_order_index, expected_effective_load)
                VALUES (${applicationId}, ${decisionId}, ${userId}, 'bench-press', ${versionId}, ${blockId}, 1, 1, 2, ${JSON.stringify({ kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" })}::jsonb)`;
      return { userId, applicationId };
    }
    const a = await athleteWithApplication();
    const b = await athleteWithApplication();

    // Pre-migration receipts exactly as the old code wrote them: ATHLETE rows
    // carry the actor (= owner), SYSTEM rows carry NULL.
    const athleteCommand = createEntityId();
    const systemCommand = createEntityId();
    const bCommand = createEntityId();
    await sql`INSERT INTO app.progression_application_commands (command_id, application_id, user_id, actor_type, action, outcome) VALUES
              (${athleteCommand}, ${a.applicationId}, ${a.userId}, 'ATHLETE', 'KEEP_ORIGINAL', 'REJECTED'),
              (${systemCommand}, ${a.applicationId}, NULL, 'SYSTEM', 'APPLY', 'REJECTED'),
              (${bCommand}, ${b.applicationId}, ${b.userId}, 'ATHLETE', 'APPLY', 'REJECTED')`;
    // Old key: A could never record its own command with the id B already used.
    await expect(sql`INSERT INTO app.progression_application_commands (command_id, application_id, user_id, actor_type, action, outcome) VALUES (${bCommand}, ${a.applicationId}, ${a.userId}, 'ATHLETE', 'APPLY', 'REJECTED')`).rejects.toThrow();

    const snapshotBefore = await sql`SELECT command_id, application_id, user_id, actor_type, action, outcome, rejection_reason, created_at FROM app.progression_application_commands ORDER BY command_id`;
    const applicationsBefore = await sql`SELECT * FROM app.progression_applications ORDER BY id`;
    const otherBefore = await schemaFingerprintExcluding(sql, ["progression_application_commands", "progression_applications"]);
    const applicationsSchemaBefore = await schemaFingerprintExcluding(sql, []);
    const appliedBefore = await appliedMigrationCount(sql);

    await migrate(drizzle(sql), { migrationsFolder: through("0023_") });
    await migrate(drizzle(sql), { migrationsFolder: through("0023_") });

    expect(await constraintDef(sql, "progression_application_commands_pkey")).toBe("PRIMARY KEY (owner_user_id, command_id)");
    expect(await appliedMigrationCount(sql)).toBe(appliedBefore + 1);

    // Every row preserved (actor columns untouched); owner = the row's own application owner.
    expect(await sql`SELECT command_id, application_id, user_id, actor_type, action, outcome, rejection_reason, created_at FROM app.progression_application_commands ORDER BY command_id`).toEqual(snapshotBefore);
    const owners = await sql`SELECT command_id, owner_user_id FROM app.progression_application_commands`;
    expect(Object.fromEntries(owners.map((row) => [row.command_id as string, row.owner_user_id as string]))).toEqual({
      [athleteCommand]: a.userId,
      [systemCommand]: a.userId,
      [bCommand]: b.userId,
    });
    expect(await sql`SELECT * FROM app.progression_applications ORDER BY id`).toEqual(applicationsBefore);
    expect(await schemaFingerprintExcluding(sql, ["progression_application_commands", "progression_applications"])).toBe(otherBefore);
    // progression_applications gained exactly one (trivially satisfied) UNIQUE(id, user_id).
    expect(await constraintDef(sql, "progression_applications_id_user_id_unique")).toBe("UNIQUE (id, user_id)");
    expect(applicationsSchemaBefore).not.toBe(await schemaFingerprintExcluding(sql, []));

    // New key: A may now use the id B used…
    await sql`INSERT INTO app.progression_application_commands (command_id, owner_user_id, application_id, user_id, actor_type, action, outcome) VALUES (${bCommand}, ${a.userId}, ${a.applicationId}, ${a.userId}, 'ATHLETE', 'APPLY', 'REJECTED')`;
    // …the same owner still cannot record one command twice…
    await expect(sql`INSERT INTO app.progression_application_commands (command_id, owner_user_id, application_id, user_id, actor_type, action, outcome) VALUES (${bCommand}, ${a.userId}, ${a.applicationId}, ${a.userId}, 'ATHLETE', 'APPLY', 'REJECTED')`).rejects.toThrow();
    // …and an owner that is not the application's owner is refused by the DB.
    await expect(sql`INSERT INTO app.progression_application_commands (command_id, owner_user_id, application_id, user_id, actor_type, action, outcome) VALUES (${createEntityId()}, ${b.userId}, ${a.applicationId}, NULL, 'SYSTEM', 'APPLY', 'REJECTED')`).rejects.toThrow();
  });
});
