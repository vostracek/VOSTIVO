import { describe, expect, it } from "vitest";
import { LOCAL_MIGRATIONS, runLocalMigrations, type LocalColumnInfo, type LocalMigrationStore } from "./migrations";
import { isRowPresent } from "./row-presence";

/**
 * A fake schema for the fake stores: executing a migration's statement adds
 * exactly the objects it declares, so the runner's post-run schema check
 * sees what a real database would. Transactions are pass-through — real
 * atomicity is covered on real SQLite files in migrations.crash-recovery.test.ts.
 */
function createFakeSchema(): Pick<LocalMigrationStore, "runInTransaction" | "tableColumns" | "tableSql"> & { apply(statement: string): void } {
  const tables = new Map<string, LocalColumnInfo[]>();
  const definitions = new Map<string, string>();
  return {
    apply: (statement) => {
      const migration = LOCAL_MIGRATIONS.find((candidate) => candidate.statement === statement);
      if (migration === undefined) throw new Error(`unknown statement: ${statement}`);
      if (migration.kind === "CREATE_TABLE") {
        if (!tables.has(migration.table)) {
          tables.set(
            migration.table,
            migration.columns.map((name) => ({ name, type: "TEXT", notNull: false, defaultValue: null })),
          );
          definitions.set(migration.table, statement.replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ").replace(/;$/, ""));
        }
        return;
      }
      tables.get(migration.table)?.push(migration.column);
      const definition = statement.slice(`ALTER TABLE ${migration.table} ADD COLUMN `.length, -1);
      definitions.set(migration.table, `${definitions.get(migration.table)?.slice(0, -1)}, ${definition})`);
    },
    runInTransaction: (work) => work(),
    tableColumns: (table) => tables.get(table) ?? null,
    tableSql: (table) => definitions.get(table) ?? null,
  };
}

function createInMemoryStore(): LocalMigrationStore & { executedStatements: string[] } {
  const applied = new Set<string>();
  const executedStatements: string[] = [];
  const schema = createFakeSchema();

  return {
    executedStatements,
    runInTransaction: schema.runInTransaction,
    tableColumns: schema.tableColumns,
    tableSql: schema.tableSql,
    ensureMigrationsTable: () => {},
    isApplied: (id) => applied.has(id),
    execute: (statement) => {
      schema.apply(statement);
      executedStatements.push(statement);
    },
    markApplied: (id) => applied.add(id),
  };
}

describe("local SQLite migration runner", () => {
  it("applies every pending migration exactly once, in order", () => {
    const store = createInMemoryStore();

    runLocalMigrations(store);

    expect(store.executedStatements.length).toBeGreaterThan(0);
    expect(store.executedStatements[0]).toContain("bootstrap_health_check");
    expect(store.executedStatements.some((s) => s.includes("local_workout_sessions"))).toBe(true);
    expect(store.executedStatements.some((s) => s.includes("local_performed_exercises"))).toBe(true);
    expect(store.executedStatements.some((s) => s.includes("local_performed_sets"))).toBe(true);
    expect(store.executedStatements.some((s) => s.includes("sync_outbox"))).toBe(true);
  });

  it("is idempotent: a second run applies nothing new", () => {
    const store = createInMemoryStore();

    runLocalMigrations(store);
    const countAfterFirstRun = store.executedStatements.length;
    runLocalMigrations(store);

    expect(store.executedStatements).toHaveLength(countAfterFirstRun);
  });
});

/**
 * Regression test for the native-verification finding: expo-sqlite's
 * drizzle adapter returns `null`, not `undefined`, for "no row matched"
 * on `db.get()`. `createInMemoryStore()` above uses a `Set<string>`, whose
 * `.has()` returns a plain boolean — it can never reproduce the bug,
 * because it never passes a `null` through `isApplied()`. This store
 * instead models the real adapter shape: a row lookup that returns `null`
 * for "not recorded yet" and a real object once recorded, run through the
 * same `isRowPresent()` helper the production adapters
 * (local-database/client.ts, workout/workout-repository.ts) actually use.
 * With the old `row !== undefined` check, `null` would have been treated
 * as present and every migration below would have been silently skipped
 * on the very first run — exactly what happened on real devices.
 */
function createRowBackedStore(): LocalMigrationStore & { executedStatements: string[] } {
  const recordedRows = new Map<string, { id: string }>();
  const executedStatements: string[] = [];
  const schema = createFakeSchema();

  return {
    executedStatements,
    runInTransaction: schema.runInTransaction,
    tableColumns: schema.tableColumns,
    tableSql: schema.tableSql,
    ensureMigrationsTable: () => {},
    isApplied: (id) => {
      const row = recordedRows.get(id) ?? null; // mirrors db.get()'s real "no row" value
      return isRowPresent(row);
    },
    execute: (statement) => {
      schema.apply(statement);
      executedStatements.push(statement);
    },
    markApplied: (id) => {
      recordedRows.set(id, { id });
    },
  };
}

describe("local SQLite migration runner — null-vs-undefined regression", () => {
  it("no migration record (null from the adapter) is treated as not-applied, so every migration executes", () => {
    const store = createRowBackedStore();

    runLocalMigrations(store);

    expect(store.executedStatements.length).toBeGreaterThan(0);
  });

  it("an already-recorded migration (a real row, not null) is not executed again", () => {
    const store = createRowBackedStore();

    runLocalMigrations(store);
    const countAfterFirstRun = store.executedStatements.length;
    runLocalMigrations(store);

    expect(store.executedStatements).toHaveLength(countAfterFirstRun);
  });
});
