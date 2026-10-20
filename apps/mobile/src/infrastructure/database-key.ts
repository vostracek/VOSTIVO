import * as Crypto from "expo-crypto";

const KEY_BYTE_LENGTH = 32; // 256-bit key for SQLCipher

/**
 * A fresh SQLCipher key for ONE athlete database (Auth & Local Athlete
 * Boundary V1 Slice B: one key per athlete, stored in SecureStore under
 * `vostivo.local-db-encryption-key.<userId>` by
 * `local-database/athlete-database.ts`). This is small security material
 * only — the encrypted SQLite database file itself stays on the filesystem
 * via expo-sqlite; SecureStore never holds workout data (spec section 4).
 *
 * The key is never logged and is only ever handed to the local-database
 * client, which feeds it directly into `PRAGMA key` and does not persist,
 * echo, or expose it further.
 */
export async function generateDatabaseKey(): Promise<string> {
  const randomBytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
