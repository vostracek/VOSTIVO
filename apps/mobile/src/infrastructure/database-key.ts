import * as Crypto from "expo-crypto";
import { getSecureValue, setSecureValue } from "./secure-store";

const DATABASE_KEY_STORAGE_KEY = "vostivo.local-db-encryption-key";
const KEY_BYTE_LENGTH = 32; // 256-bit key for SQLCipher

/**
 * The local SQLCipher database key: generated once on first run, then
 * persisted in SecureStore and reused. This is small security material
 * only — the encrypted SQLite *database file itself* stays on the
 * filesystem via expo-sqlite; SecureStore never holds workout data (spec
 * section 4).
 *
 * The key is never logged and is only ever returned to the local-database
 * client, which feeds it directly into `PRAGMA key` and does not persist,
 * echo, or expose it further.
 */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const existing = await getSecureValue(DATABASE_KEY_STORAGE_KEY);
  if (existing !== null) {
    assertValidKeyFormat(existing);
    return existing;
  }

  const randomBytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
  const key = bytesToHex(randomBytes);

  await setSecureValue(DATABASE_KEY_STORAGE_KEY, key);
  return key;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Defensive guard before this value is ever interpolated into a `PRAGMA
 * key` statement (SQLite PRAGMAs do not support bound `?` parameters, so
 * the key must be inlined as SQL text — see local-database/client.ts). The
 * key is never user input; this only protects against a corrupted or
 * tampered SecureStore value ever reaching raw SQL.
 */
function assertValidKeyFormat(key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error("Stored database key has an unexpected format");
  }
}
