import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Harmless technical table that exists only to prove the Drizzle migration
 * pipeline (generate -> SQL migration -> apply) works end-to-end. It is not
 * part of the Vostivo domain and must not gain product columns — the first
 * real feature schema is a separate, later vertical slice (spec section 17).
 */
export const bootstrapHealthCheck = pgTable("bootstrap_health_check", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
});
