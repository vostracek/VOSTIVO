import { SessionStorageUnavailableError } from "../identity/auth-session";
import type { SecureValueStore } from "../identity/secure-value-store";

/**
 * Auth Slice C — Supabase session persistence in the platform keystore
 * (expo-secure-store), never plaintext AsyncStorage, and never a plaintext
 * fallback.
 *
 * A Supabase session (access + refresh token + user) is larger than what
 * SecureStore reliably holds in one value (~2 KB), so a value is stored as
 * CHUNKS of one GENERATION plus a MANIFEST that names the current
 * generation:
 *
 *   <prefix>.<slot>.manifest          {"v":1,"generation":N,"chunks":C,"length":L,"checksum":H}
 *   <prefix>.<slot>.g<N>.<0..C-1>     the value's chunks
 *
 * Write: every chunk of generation N+1 first, the manifest LAST (the only
 * switch), then the old generation is removed. A crash before the manifest
 * switch leaves the previous session fully readable; a crash after it only
 * leaves garbage chunks behind. Read: manifest -> every expected chunk ->
 * length + checksum; anything missing or inconsistent fails closed (`null`,
 * i.e. no session) — a partial session is never reconstructed. A keystore
 * that cannot be read/written raises `SessionStorageUnavailableError` (a
 * typed failure, never "signed out", never a reason to delete anything).
 *
 * Never logs: values are tokens.
 */
export const SESSION_STORAGE_KEY_PREFIX = "vostivo.auth";
/** Characters per chunk — comfortably below SecureStore's ~2048-byte value guidance for ASCII JSON. */
export const SESSION_CHUNK_SIZE = 1800;
/** Upper bound for sweeping leftover chunks of an interrupted earlier write. */
const MAX_STALE_CHUNK_SWEEP = 32;

interface Manifest {
  readonly v: 1;
  readonly generation: number;
  readonly chunks: number;
  readonly length: number;
  readonly checksum: string;
}

/** The storage contract `@supabase/supabase-js` accepts as `auth.storage`. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class ChunkedSecureSessionStorage implements AsyncKeyValueStorage {
  constructor(
    private readonly store: SecureValueStore,
    private readonly chunkSize: number = SESSION_CHUNK_SIZE,
  ) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error("chunkSize must be a positive integer");
  }

  async getItem(key: string): Promise<string | null> {
    const manifest = await this.readManifest(key);
    if (manifest === null) return null;

    const chunks: string[] = [];
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = await this.guard(() => this.store.get(chunkKey(key, manifest.generation, index)));
      if (chunk === null) return null;
      chunks.push(chunk);
    }
    const value = chunks.join("");
    if (value.length !== manifest.length || checksum(value) !== manifest.checksum) return null;
    return value;
  }

  async setItem(key: string, value: string): Promise<void> {
    const previous = await this.readManifest(key);
    const generation = (previous?.generation ?? 0) + 1;
    const chunks = splitIntoChunks(value, this.chunkSize);

    for (const [index, chunk] of chunks.entries()) {
      await this.guard(() => this.store.set(chunkKey(key, generation, index), chunk));
    }
    const manifest: Manifest = { v: 1, generation, chunks: chunks.length, length: value.length, checksum: checksum(value) };
    await this.guard(() => this.store.set(manifestKey(key), JSON.stringify(manifest)));

    // The switch is done; cleanup is best effort (garbage never becomes readable).
    if (previous !== null) await this.deleteChunks(key, previous.generation, 0, previous.chunks);
    await this.sweepStaleChunks(key, generation, chunks.length);
  }

  async removeItem(key: string): Promise<void> {
    const previous = await this.readManifest(key);
    // Manifest first: the value disappears atomically, chunks are garbage after this.
    await this.guard(() => this.store.delete(manifestKey(key)));
    if (previous !== null) await this.deleteChunks(key, previous.generation, 0, previous.chunks);
  }

  private async readManifest(key: string): Promise<Manifest | null> {
    const raw = await this.guard(() => this.store.get(manifestKey(key)));
    if (raw === null) return null;
    return parseManifest(raw);
  }

  /** Leftovers of an interrupted earlier write of this same generation number beyond the current chunk count. */
  private async sweepStaleChunks(key: string, generation: number, from: number): Promise<void> {
    for (let index = from; index < from + MAX_STALE_CHUNK_SWEEP; index += 1) {
      const leftover = await this.store.get(chunkKey(key, generation, index)).catch(() => null);
      if (leftover === null) return;
      await this.store.delete(chunkKey(key, generation, index)).catch(() => undefined);
    }
  }

  private async deleteChunks(key: string, generation: number, from: number, to: number): Promise<void> {
    for (let index = from; index < to; index += 1) {
      await this.store.delete(chunkKey(key, generation, index)).catch(() => undefined);
    }
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new SessionStorageUnavailableError();
    }
  }
}

function slot(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

function manifestKey(key: string): string {
  return `${SESSION_STORAGE_KEY_PREFIX}.${slot(key)}.manifest`;
}

function chunkKey(key: string, generation: number, index: number): string {
  return `${SESSION_STORAGE_KEY_PREFIX}.${slot(key)}.g${generation}.${index}`;
}

function splitIntoChunks(value: string, size: number): string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.slice(offset, offset + size));
  return chunks;
}

function parseManifest(raw: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<Manifest>;
  const isCount = (value: unknown, min: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
  if (candidate.v !== 1 || !isCount(candidate.generation, 1) || !isCount(candidate.chunks, 1) || !isCount(candidate.length, 0) || typeof candidate.checksum !== "string") return null;
  return { v: 1, generation: candidate.generation, chunks: candidate.chunks, length: candidate.length, checksum: candidate.checksum };
}

/** FNV-1a 32-bit over UTF-16 code units — an integrity check against torn/mixed chunks, not a security primitive. */
function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
