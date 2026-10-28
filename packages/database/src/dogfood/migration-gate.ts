/**
 * Dogfood bootstrap's migration gate: when migrations are pending on a
 * schema that already has applied migrations (existing state), a
 * `pre-migration` backup must be written AND pass the restore-check before
 * any migration runs. Any failure there propagates and `migrate` is never
 * called (fail-closed). A brand-new empty schema migrates without a backup
 * (nothing to lose); nothing pending -> no backup.
 */
export type MigrationGateOutcome = "FRESH_SCHEMA" | "BACKED_UP_THEN_MIGRATED" | "NOTHING_PENDING";

export async function migrateBehindPreMigrationBackup(params: {
  readonly appliedMigrations: number;
  readonly journalMigrations: number;
  /** Writes the `pre-migration` backup and runs its restore-check; must throw on any failure. */
  readonly backupAndVerify: () => Promise<void>;
  readonly migrate: () => Promise<void>;
}): Promise<MigrationGateOutcome> {
  const pending = params.journalMigrations - params.appliedMigrations;
  if (pending <= 0) {
    // Still run the migrator: a no-op when current, and it never runs anything not in the journal.
    await params.migrate();
    return "NOTHING_PENDING";
  }
  if (params.appliedMigrations === 0) {
    await params.migrate();
    return "FRESH_SCHEMA";
  }
  await params.backupAndVerify();
  await params.migrate();
  return "BACKED_UP_THEN_MIGRATED";
}
