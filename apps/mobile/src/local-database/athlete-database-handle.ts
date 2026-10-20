import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import type * as schema from "./schema";

export type LocalDatabase = ExpoSQLiteDatabase<typeof schema>;

/** One opened athlete database (Slice B). `close()` is awaited by the IdentityGate before another owner's database is opened. */
export interface AthleteDatabaseHandle {
  readonly db: LocalDatabase;
  close(): Promise<void>;
}
