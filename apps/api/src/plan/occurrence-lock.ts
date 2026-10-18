import { sql } from "drizzle-orm";
import type { Database } from "@vostivo/database";

/**
 * Serializes everything that decides a planned occurrence's pre-start state
 * for one athlete: Temporary Equipment apply and the planned START take the
 * SAME transaction-scoped advisory lock, so a START can never slip in
 * between an apply's re-validation ("no canonical session yet") and its
 * write — the later of the two always observes the earlier one's commit
 * (READ COMMITTED). No table lock, no privilege needed, released at
 * commit/rollback.
 */
export async function lockPlannedOccurrence(tx: Database, userId: string, plannedWorkoutId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`planned-occurrence:${userId}:${plannedWorkoutId}`}, 0))`);
}
