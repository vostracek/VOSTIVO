/**
 * Dogfood backup retention policy V1 (pure, deterministic for a given `now`):
 * - keep every backup younger than 14 days;
 * - 14 days .. 8 weeks: keep the newest backup of each ISO week (UTC);
 * - keep `pre-migration` / `pre-import` backups for at least 30 days;
 * - ALWAYS keep the newest backup and the newest verified backup, whatever their age.
 * Everything else is a prune candidate. Pruning itself is dry-run by default.
 */
export const BACKUP_REASONS = ["manual", "daily", "pre-migration", "pre-import"] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export interface BackupEntry {
  /** Base name without extension, e.g. `vostivo_dogfood-20261028T171900Z-manual`. */
  readonly baseName: string;
  readonly createdAt: Date;
  readonly reason: BackupReason;
  readonly verified: boolean;
}

export interface RetentionDecision {
  readonly keep: readonly { readonly entry: BackupEntry; readonly why: string }[];
  readonly prune: readonly BackupEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_KEEP_ALL_DAYS = 14;
export const RETENTION_WEEKLY_WEEKS = 8;
export const RETENTION_PRE_CHANGE_DAYS = 30;

export function decideRetention(entries: readonly BackupEntry[], now: Date): RetentionDecision {
  const sorted = [...entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const newest = sorted[0];
  const newestVerified = sorted.find((entry) => entry.verified);
  const weeksSeen = new Set<string>();
  const keep: { entry: BackupEntry; why: string }[] = [];
  const prune: BackupEntry[] = [];

  for (const entry of sorted) {
    const ageDays = (now.getTime() - entry.createdAt.getTime()) / DAY_MS;
    const week = isoWeekKey(entry.createdAt);
    let why: string | null = null;
    if (entry === newest) why = "newest backup";
    else if (entry === newestVerified) why = "newest verified backup";
    else if (ageDays < RETENTION_KEEP_ALL_DAYS) why = `younger than ${RETENTION_KEEP_ALL_DAYS} days`;
    else if ((entry.reason === "pre-migration" || entry.reason === "pre-import") && ageDays < RETENTION_PRE_CHANGE_DAYS) {
      why = `${entry.reason} younger than ${RETENTION_PRE_CHANGE_DAYS} days`;
    } else if (ageDays < RETENTION_WEEKLY_WEEKS * 7 && !weeksSeen.has(week)) why = `newest of ISO week ${week}`;

    // A kept backup "occupies" its week, so an older one in the same week is not also kept as the weekly copy.
    if (why !== null) {
      weeksSeen.add(week);
      keep.push({ entry, why });
    } else {
      prune.push(entry);
    }
  }
  return { keep, prune };
}

/** ISO-8601 week key (`2026-W44`) in UTC. */
export function isoWeekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
