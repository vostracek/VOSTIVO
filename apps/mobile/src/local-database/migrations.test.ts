import { describe, expect, it } from "vitest";
import { runLocalMigrations, type LocalMigrationStore } from "./migrations";
import { isRowPresent } from "./row-presence";

function createInMemoryStore(): LocalMigrationStore & { executedStatements: string[] } {
  const applied = new Set<string>();
  const executedStatements: string[] = [];

  return {
    executedStatements,
    ensureMigrationsTable: () => {},
    isApplied: (id) => applied.has(id),
    execute: (statement) => executedStatements.push(statement),
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

  return {
    executedStatements,
    ensureMigrationsTable: () => {},
    isApplied: (id) => {
      const row = recordedRows.get(id) ?? null; // mirrors db.get()'s real "no row" value
      return isRowPresent(row);
    },
    execute: (statement) => executedStatements.push(statement),
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
