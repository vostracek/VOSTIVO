import { describe, expect, it, vi } from "vitest";
import { migrateBehindPreMigrationBackup } from "./migration-gate.js";

function harness(appliedMigrations: number, journalMigrations: number, backupAndVerify: () => Promise<void> = () => Promise.resolve()) {
  const calls: string[] = [];
  const deps = {
    appliedMigrations,
    journalMigrations,
    backupAndVerify: vi.fn(async () => {
      calls.push("backup+verify");
      await backupAndVerify();
    }),
    migrate: vi.fn(() => {
      calls.push("migrate");
      return Promise.resolve();
    }),
  };
  return { deps, calls };
}

describe("dogfood bootstrap migration gate (pre-migration backup, fail-closed)", () => {
  it("DOGFOOD-MIG-001: pending migrations on existing state -> backup + restore-check strictly BEFORE migrate", async () => {
    const { deps, calls } = harness(23, 24);
    await expect(migrateBehindPreMigrationBackup(deps)).resolves.toBe("BACKED_UP_THEN_MIGRATED");
    expect(calls).toEqual(["backup+verify", "migrate"]);
  });

  it("DOGFOOD-MIG-002: a failing backup or restore-check stops the bootstrap — migrate never runs", async () => {
    for (const failure of ["pg_dump exited with 1", "Restore-check failed: app.users: manifest 2 rows, restored 1"]) {
      const { deps, calls } = harness(23, 24, () => Promise.reject(new Error(failure)));
      await expect(migrateBehindPreMigrationBackup(deps)).rejects.toThrow(failure);
      expect(deps.migrate).not.toHaveBeenCalled();
      expect(calls).toEqual(["backup+verify"]);
    }
  });

  it("DOGFOOD-MIG-003: a brand-new empty schema initializes without a backup", async () => {
    const { deps, calls } = harness(0, 23);
    await expect(migrateBehindPreMigrationBackup(deps)).resolves.toBe("FRESH_SCHEMA");
    expect(calls).toEqual(["migrate"]);
  });

  it("DOGFOOD-MIG-004: a repeated bootstrap with nothing pending writes no backup", async () => {
    const { deps } = harness(23, 23);
    await expect(migrateBehindPreMigrationBackup(deps)).resolves.toBe("NOTHING_PENDING");
    expect(deps.backupAndVerify).not.toHaveBeenCalled();
  });
});
