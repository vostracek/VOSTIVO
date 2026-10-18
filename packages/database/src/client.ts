import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Creates a Drizzle client for a given connection string. Never hardcode a
 * connection string here — it always comes from validated config
 * (see `loadDatabaseConfig`), so development can never silently point at
 * production by falling back to a baked-in default.
 */
export function createDatabaseClient(connectionString: string): Database {
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}
