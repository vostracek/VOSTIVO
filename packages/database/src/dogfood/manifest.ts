import { BACKUP_REASONS, type BackupReason } from "./retention.js";

/**
 * Dogfood backup manifest V1 — the control data written next to every
 * `pg_dump -Fc` file. Row counts are taken inside the SAME exported
 * snapshot pg_dump dumps from (`pg_export_snapshot()` + `pg_dump
 * --snapshot`), so they describe exactly the dumped data; the restore check
 * compares a real restore against them. Contains no row data, no
 * credentials and no connection strings.
 */
export const MANIFEST_VERSION = 1;

export interface BackupManifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly dumpFile: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: {
    readonly databaseName: string;
    readonly marker: string | null;
    readonly serverVersion: string;
  };
  readonly migrations: { readonly count: number; readonly latestCreatedAt: string | null };
  /** `schema.table` -> row count, sorted by key. */
  readonly tableRowCounts: Readonly<Record<string, number>>;
}

export interface RestoreVerification {
  readonly dumpFile: string;
  readonly verifiedAt: string;
  readonly restoreDatabase: string;
  readonly sha256Matched: boolean;
  readonly mismatches: readonly string[];
  readonly ok: boolean;
}

const BASE_NAME = /^vostivo_dogfood-(\d{8}T\d{6}Z)-([a-z-]+)$/;

export function backupBaseName(createdAt: Date, reason: BackupReason): string {
  const stamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `vostivo_dogfood-${stamp}-${reason}`;
}

/** Parses only names this tool itself writes; anything else in the directory is ignored (never pruned). */
export function parseBackupBaseName(baseName: string): { createdAt: Date; reason: BackupReason } | null {
  const match = BASE_NAME.exec(baseName);
  if (match === null) return null;
  const [, stamp, reason] = match as unknown as [string, string, string];
  if (!(BACKUP_REASONS as readonly string[]).includes(reason)) return null;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, reason: reason as BackupReason };
}

/** Exact comparison of a restored database's control data against the manifest. Empty = match. */
export function compareWithManifest(
  manifest: Pick<BackupManifest, "migrations" | "tableRowCounts">,
  restored: Pick<BackupManifest, "migrations" | "tableRowCounts">,
): string[] {
  const mismatches: string[] = [];
  if (manifest.migrations.count !== restored.migrations.count) {
    mismatches.push(`migration count: manifest ${manifest.migrations.count}, restored ${restored.migrations.count}`);
  }
  if (manifest.migrations.latestCreatedAt !== restored.migrations.latestCreatedAt) {
    mismatches.push("latest migration differs");
  }
  const tables = new Set([...Object.keys(manifest.tableRowCounts), ...Object.keys(restored.tableRowCounts)]);
  for (const table of [...tables].sort()) {
    const expected = manifest.tableRowCounts[table];
    const actual = restored.tableRowCounts[table];
    if (expected === undefined) mismatches.push(`${table}: not in manifest`);
    else if (actual === undefined) mismatches.push(`${table}: missing after restore`);
    else if (expected !== actual) mismatches.push(`${table}: manifest ${expected} rows, restored ${actual}`);
  }
  return mismatches;
}
