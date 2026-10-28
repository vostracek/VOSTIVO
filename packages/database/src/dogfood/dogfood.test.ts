import { describe, expect, it } from "vitest";
import { DataEnvironmentMismatchError } from "../data-environment.js";
import { backupBaseName, compareWithManifest, parseBackupBaseName } from "./manifest.js";
import { decideRetention, isoWeekKey, type BackupEntry } from "./retention.js";
import { assertDogfoodConnectionTarget, assertOutsideRepository, DOGFOOD_OWNER_ROLE, DOGFOOD_RUNTIME_ROLE } from "./target.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const entry = (days: number, overrides: Partial<BackupEntry> = {}): BackupEntry => ({
  baseName: `b-${days}`,
  createdAt: daysAgo(days),
  reason: "daily",
  verified: true,
  ...overrides,
});
const pruned = (entries: BackupEntry[]): string[] => decideRetention(entries, NOW).prune.map((e) => e.baseName);

describe("dogfood connection target", () => {
  const url = (user: string, host = "127.0.0.1", port = "5433", db = "vostivo_dogfood") => `postgres://${user}:x@${host}:${port}/${db}`;

  it("DOGFOOD-TARGET-001: accepts exactly 127.0.0.1:5433/vostivo_dogfood as the expected role", () => {
    expect(() => assertDogfoodConnectionTarget(url(DOGFOOD_OWNER_ROLE), DOGFOOD_OWNER_ROLE)).not.toThrow();
    expect(() => assertDogfoodConnectionTarget(url(DOGFOOD_RUNTIME_ROLE), DOGFOOD_RUNTIME_ROLE)).not.toThrow();
  });

  it("DOGFOOD-TARGET-002: refuses the dev instance, another database, another host or a dev role", () => {
    for (const bad of [
      url(DOGFOOD_OWNER_ROLE, "127.0.0.1", "5432"),
      url(DOGFOOD_OWNER_ROLE, "127.0.0.1", "5433", "vostivo_manual"),
      url(DOGFOOD_OWNER_ROLE, "db.example.com"),
      url("vostivo"),
      url(DOGFOOD_RUNTIME_ROLE),
    ]) {
      expect(() => assertDogfoodConnectionTarget(bad, DOGFOOD_OWNER_ROLE)).toThrow(DataEnvironmentMismatchError);
    }
  });

  it("DOGFOOD-TARGET-003: backup/config paths inside the repository are refused", () => {
    expect(() => assertOutsideRepository("/repo/backups", "/repo")).toThrow(DataEnvironmentMismatchError);
    expect(() => assertOutsideRepository("/repo", "/repo")).toThrow(DataEnvironmentMismatchError);
    expect(() => assertOutsideRepository("/home/u/VostivoBackups/dogfood", "/repo")).not.toThrow();
  });
});

describe("backup naming", () => {
  it("DOGFOOD-BACKUP-001: round-trips the UTC timestamp and reason; foreign files are ignored", () => {
    const name = backupBaseName(new Date("2026-10-28T17:19:05.123Z"), "pre-migration");
    expect(name).toBe("vostivo_dogfood-20261028T171905Z-pre-migration");
    expect(parseBackupBaseName(name)).toEqual({ createdAt: new Date("2026-10-28T17:19:05Z"), reason: "pre-migration" });
    expect(parseBackupBaseName("vostivo_dogfood-20261028T171905Z-bogus")).toBeNull();
    expect(parseBackupBaseName("notes")).toBeNull();
  });
});

describe("manifest comparison", () => {
  const manifest = { migrations: { count: 23, latestCreatedAt: "1" }, tableRowCounts: { "app.users": 2, "app.workout_sessions": 5 } };

  it("DOGFOOD-BACKUP-002: identical control data -> no mismatch", () => {
    expect(compareWithManifest(manifest, structuredClone(manifest))).toEqual([]);
  });

  it("DOGFOOD-BACKUP-003: any count, table-set or migration difference is reported", () => {
    expect(compareWithManifest(manifest, { ...manifest, tableRowCounts: { "app.users": 2, "app.workout_sessions": 4 } })).toHaveLength(1);
    expect(compareWithManifest(manifest, { ...manifest, tableRowCounts: { "app.users": 2 } })).toEqual(["app.workout_sessions: missing after restore"]);
    expect(compareWithManifest(manifest, { ...manifest, tableRowCounts: { ...manifest.tableRowCounts, "app.x": 0 } })).toEqual(["app.x: not in manifest"]);
    expect(compareWithManifest(manifest, { ...manifest, migrations: { count: 22, latestCreatedAt: "0" } })).toHaveLength(2);
  });
});

describe("retention policy", () => {
  it("DOGFOOD-RET-001: everything younger than 14 days is kept", () => {
    expect(pruned([entry(0), entry(1), entry(5), entry(13.9)])).toEqual([]);
  });

  it("DOGFOOD-RET-002: 14 days .. 8 weeks keeps only the newest backup per ISO week", () => {
    // 2026-10-07 (Wed) and 2026-10-06 (Tue) share ISO week 41; 2026-09-30 is week 40.
    const wed = entry(21, { baseName: "wk41-wed" });
    const tue = entry(22, { baseName: "wk41-tue" });
    const prev = entry(28, { baseName: "wk40" });
    expect(isoWeekKey(wed.createdAt)).toBe(isoWeekKey(tue.createdAt));
    expect(pruned([entry(0), wed, tue, prev])).toEqual(["wk41-tue"]);
  });

  it("DOGFOOD-RET-003: older than 8 weeks is pruned, except the newest and the newest verified", () => {
    expect(pruned([entry(0), entry(70, { baseName: "old" })])).toEqual(["old"]);
    expect(pruned([entry(70, { baseName: "only" })])).toEqual([]);
    expect(pruned([entry(0, { verified: false }), entry(80, { baseName: "verified" }), entry(90, { baseName: "x" })])).toEqual(["x"]);
  });

  it("DOGFOOD-RET-004: pre-migration / pre-import backups survive at least 30 days even inside one week", () => {
    const a = entry(20, { baseName: "pre-mig", reason: "pre-migration" });
    const b = entry(20.5, { baseName: "pre-imp", reason: "pre-import" });
    const c = entry(20.7, { baseName: "daily" });
    expect(pruned([entry(0), a, b, c])).toEqual(["daily"]);
    expect(pruned([entry(0), entry(31, { baseName: "old-pre", reason: "pre-migration" }), entry(31.1, { baseName: "older-pre", reason: "pre-migration" })])).toEqual([
      "older-pre",
    ]);
  });

  it("DOGFOOD-RET-005: deterministic regardless of input order", () => {
    const entries = [entry(3), entry(40), entry(20), entry(60), entry(15)];
    expect(pruned([...entries].reverse())).toEqual(pruned(entries));
  });
});
