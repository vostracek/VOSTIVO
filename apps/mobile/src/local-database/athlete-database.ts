/**
 * Auth & Local Athlete Boundary V1 Slice B — ONE ENCRYPTED SQLITE DATABASE
 * PER ATHLETE. Physical separation is the ownership boundary: the tables
 * carry no owner column, and a runtime can only ever reach the one file it
 * was opened with. Framework-free (ports), so the whole open policy —
 * naming, key handling, every failure case — is unit tested; `client.ts`
 * wires the native expo-sqlite/SecureStore ports.
 */

/**
 * The pre-Slice-B single database and its device key. QUARANTINED (D-6):
 * no code path opens, keys, syncs, renames or deletes them — they are named
 * here only so that tests can prove nothing ever touches them.
 */
export const LEGACY_DATABASE_NAME = "vostivo.db";
export const LEGACY_DATABASE_KEY_STORAGE_KEY = "vostivo.local-db-encryption-key";

/** Server user ids are UUIDs; anything else is refused before it can reach a file name or a SecureStore key. */
const OWNER_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATABASE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function assertOwnerUserId(userId: string): void {
  if (!OWNER_USER_ID_PATTERN.test(userId)) throw new Error("Refusing a non-UUID owner userId for local storage");
}

/** `vostivo-athlete-<userId>.db` — deterministic, no email/display name. */
export function athleteDatabaseName(userId: string): string {
  assertOwnerUserId(userId);
  return `vostivo-athlete-${userId}.db`;
}

/** `vostivo.local-db-encryption-key.<userId>` — one SQLCipher key per athlete database. */
export function athleteDatabaseKeyStorageKey(userId: string): string {
  assertOwnerUserId(userId);
  return `${LEGACY_DATABASE_KEY_STORAGE_KEY}.${userId}`;
}

/** What is on disk under an athlete database name, determined WITHOUT the key. */
export type DatabaseFileState = "EMPTY" | "HAS_CONTENT";

export type LocalDataUnavailableReason =
  /** CASE C: the file holds data but its key is gone — never re-keyed, overwritten or deleted. */
  | "KEY_MISSING"
  /** The stored key is malformed (tampered/corrupted SecureStore value). */
  | "KEY_INVALID"
  /** The key does not open the file (wrong key / corrupted file). */
  | "OPEN_FAILED";

export type AthleteDatabaseOpenDecision =
  /** CASE A: nothing on disk, no key -> generate a key, create the database. */
  | { readonly kind: "CREATE_WITH_NEW_KEY" }
  /** CASE D: a key from an earlier, interrupted first open, nothing on disk -> create with that key. */
  | { readonly kind: "CREATE_WITH_EXISTING_KEY" }
  /** CASE B: data and key -> open normally. */
  | { readonly kind: "OPEN_EXISTING" }
  | { readonly kind: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason };

export function decideAthleteDatabaseOpen(fileState: DatabaseFileState, storedKey: string | null): AthleteDatabaseOpenDecision {
  if (storedKey !== null && !DATABASE_KEY_PATTERN.test(storedKey)) return { kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_INVALID" };
  if (fileState === "HAS_CONTENT") return storedKey === null ? { kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_MISSING" } : { kind: "OPEN_EXISTING" };
  return storedKey === null ? { kind: "CREATE_WITH_NEW_KEY" } : { kind: "CREATE_WITH_EXISTING_KEY" };
}

export interface AthleteDatabasePorts<Handle> {
  readKey(storageKey: string): Promise<string | null>;
  writeKey(storageKey: string, key: string): Promise<void>;
  /** 256-bit random key as 64 lowercase hex characters. */
  generateKey(): Promise<string>;
  /** Inspects the file under `databaseName` without a key; never writes data. */
  probeFile(databaseName: string): DatabaseFileState;
  /** Opens + keys + verifies + migrates; throws if the key does not open the file (the handle is closed on failure). */
  openKeyed(databaseName: string, key: string): Handle;
}

export type OpenAthleteDatabaseResult<Handle> =
  | { readonly kind: "OPENED"; readonly handle: Handle; readonly databaseName: string }
  | { readonly kind: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason };

/**
 * Key handling order: the new key is persisted BEFORE the database is
 * created, so a crash in between leaves CASE D (key, no data) — never data
 * without its key. No branch ever deletes, renames or overwrites a file or
 * a key.
 */
export async function openAthleteDatabase<Handle>(userId: string, ports: AthleteDatabasePorts<Handle>): Promise<OpenAthleteDatabaseResult<Handle>> {
  const databaseName = athleteDatabaseName(userId);
  const keyStorageKey = athleteDatabaseKeyStorageKey(userId);

  const storedKey = await ports.readKey(keyStorageKey);
  const decision = decideAthleteDatabaseOpen(ports.probeFile(databaseName), storedKey);

  let key: string;
  switch (decision.kind) {
    case "LOCAL_DATA_UNAVAILABLE":
      return decision;
    case "CREATE_WITH_NEW_KEY":
      key = await ports.generateKey();
      await ports.writeKey(keyStorageKey, key);
      break;
    case "CREATE_WITH_EXISTING_KEY":
    case "OPEN_EXISTING":
      key = storedKey as string;
      break;
  }

  try {
    return { kind: "OPENED", handle: ports.openKeyed(databaseName, key), databaseName };
  } catch {
    return { kind: "LOCAL_DATA_UNAVAILABLE", reason: "OPEN_FAILED" };
  }
}
