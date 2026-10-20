import { describe, expect, it } from "vitest";
import {
  LEGACY_DATABASE_KEY_STORAGE_KEY,
  LEGACY_DATABASE_NAME,
  athleteDatabaseKeyStorageKey,
  athleteDatabaseName,
  decideAthleteDatabaseOpen,
  openAthleteDatabase,
  type AthleteDatabasePorts,
  type DatabaseFileState,
} from "./athlete-database";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";
const KEY_1 = "1".repeat(64);
const KEY_2 = "2".repeat(64);

/**
 * TEST-ONLY device: SecureStore + filesystem state and a log of every
 * touched name. A database "file" holds the key it was created with; the
 * port surface has no delete/rename — the test also proves no existing
 * file or key is ever replaced.
 */
class FakeDevice implements AthleteDatabasePorts<{ readonly name: string }> {
  readonly keys = new Map<string, string>();
  readonly files = new Map<string, string>();
  readonly touched: string[] = [];
  private nextKey = 0;

  readKey(storageKey: string): Promise<string | null> {
    this.touched.push(storageKey);
    return Promise.resolve(this.keys.get(storageKey) ?? null);
  }
  writeKey(storageKey: string, key: string): Promise<void> {
    this.touched.push(storageKey);
    if (this.keys.has(storageKey)) throw new Error(`key overwritten: ${storageKey}`);
    this.keys.set(storageKey, key);
    return Promise.resolve();
  }
  generateKey(): Promise<string> {
    this.nextKey += 1;
    return Promise.resolve(String(this.nextKey).repeat(64).slice(0, 64));
  }
  probeFile(databaseName: string): DatabaseFileState {
    this.touched.push(databaseName);
    return this.files.has(databaseName) ? "HAS_CONTENT" : "EMPTY";
  }
  openKeyed(databaseName: string, key: string): { readonly name: string } {
    this.touched.push(databaseName);
    const fileKey = this.files.get(databaseName);
    if (fileKey !== undefined && fileKey !== key) throw new Error("file is not a database");
    this.files.set(databaseName, key);
    return { name: databaseName };
  }
}

describe("per-athlete database naming", () => {
  it("LOCAL-16/17: deterministic, owner-specific file names and SecureStore key names (no email/display name)", () => {
    expect(athleteDatabaseName(A)).toBe(`vostivo-athlete-${A}.db`);
    expect(athleteDatabaseKeyStorageKey(A)).toBe(`vostivo.local-db-encryption-key.${A}`);
    expect(athleteDatabaseName(A)).not.toBe(athleteDatabaseName(B));
    expect(athleteDatabaseKeyStorageKey(A)).not.toBe(athleteDatabaseKeyStorageKey(B));
    expect([athleteDatabaseName(A), athleteDatabaseName(B)]).not.toContain(LEGACY_DATABASE_NAME);
  });

  it("refuses anything but a UUID owner (no path or key injection)", () => {
    for (const bad of ["", "../vostivo", "a@b.c", `${A}/x`, A.toUpperCase()]) {
      expect(() => athleteDatabaseName(bad)).toThrow();
      expect(() => athleteDatabaseKeyStorageKey(bad)).toThrow();
    }
  });
});

describe("decideAthleteDatabaseOpen — cases A-D", () => {
  it("A: no file, no key -> create with a new key", () => expect(decideAthleteDatabaseOpen("EMPTY", null)).toEqual({ kind: "CREATE_WITH_NEW_KEY" }));
  it("B: file + key -> open", () => expect(decideAthleteDatabaseOpen("HAS_CONTENT", KEY_1)).toEqual({ kind: "OPEN_EXISTING" }));
  it("C: file without key -> LOCAL_DATA_UNAVAILABLE", () => expect(decideAthleteDatabaseOpen("HAS_CONTENT", null)).toEqual({ kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_MISSING" }));
  it("D: key without file -> create with that key", () => expect(decideAthleteDatabaseOpen("EMPTY", KEY_1)).toEqual({ kind: "CREATE_WITH_EXISTING_KEY" }));
  it("a malformed stored key is never used", () => expect(decideAthleteDatabaseOpen("HAS_CONTENT", "x'; DROP")).toEqual({ kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_INVALID" }));
});

describe("openAthleteDatabase", () => {
  it("LOCAL-16/17: A and B get physically separate files with separate keys", async () => {
    const device = new FakeDevice();
    const a = await openAthleteDatabase(A, device);
    const b = await openAthleteDatabase(B, device);

    expect(a).toMatchObject({ kind: "OPENED", databaseName: athleteDatabaseName(A) });
    expect(b).toMatchObject({ kind: "OPENED", databaseName: athleteDatabaseName(B) });
    expect(device.keys.get(athleteDatabaseKeyStorageKey(A))).not.toBe(device.keys.get(athleteDatabaseKeyStorageKey(B)));
    expect(device.files.get(athleteDatabaseName(A))).toBe(device.keys.get(athleteDatabaseKeyStorageKey(A)));
  });

  it("reopening the same owner reuses its file and key (no new key, no rebuild)", async () => {
    const device = new FakeDevice();
    await openAthleteDatabase(A, device);
    const keyBefore = device.keys.get(athleteDatabaseKeyStorageKey(A));
    expect(await openAthleteDatabase(A, device)).toMatchObject({ kind: "OPENED" });
    expect(device.keys.get(athleteDatabaseKeyStorageKey(A))).toBe(keyBefore);
  });

  it("LOCAL-18: existing DB + missing key -> LOCAL_DATA_UNAVAILABLE, no key generated, the file is not touched", async () => {
    const device = new FakeDevice();
    device.files.set(athleteDatabaseName(A), KEY_1);

    expect(await openAthleteDatabase(A, device)).toEqual({ kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_MISSING" });
    expect(device.keys.size).toBe(0);
    expect(device.files.get(athleteDatabaseName(A))).toBe(KEY_1);
  });

  it("a key that does not open the file -> LOCAL_DATA_UNAVAILABLE, file and key both kept", async () => {
    const device = new FakeDevice();
    device.files.set(athleteDatabaseName(A), KEY_1);
    device.keys.set(athleteDatabaseKeyStorageKey(A), KEY_2);

    expect(await openAthleteDatabase(A, device)).toEqual({ kind: "LOCAL_DATA_UNAVAILABLE", reason: "OPEN_FAILED" });
    expect(device.files.get(athleteDatabaseName(A))).toBe(KEY_1);
    expect(device.keys.get(athleteDatabaseKeyStorageKey(A))).toBe(KEY_2);
  });

  it("CASE D: a key left by an interrupted first open is reused for the new file", async () => {
    const device = new FakeDevice();
    device.keys.set(athleteDatabaseKeyStorageKey(A), KEY_2);
    expect(await openAthleteDatabase(A, device)).toMatchObject({ kind: "OPENED" });
    expect(device.files.get(athleteDatabaseName(A))).toBe(KEY_2);
  });

  it("LOCAL-19/20: the legacy vostivo.db and its device key are never read, opened or written; opening B leaves A's file and key intact", async () => {
    const device = new FakeDevice();
    device.files.set(LEGACY_DATABASE_NAME, KEY_1);
    device.keys.set(LEGACY_DATABASE_KEY_STORAGE_KEY, KEY_1);

    await openAthleteDatabase(A, device);
    const aFile = device.files.get(athleteDatabaseName(A));
    const aKey = device.keys.get(athleteDatabaseKeyStorageKey(A));
    await openAthleteDatabase(B, device);
    await openAthleteDatabase(A, device);

    expect(device.touched).not.toContain(LEGACY_DATABASE_NAME);
    expect(device.touched).not.toContain(LEGACY_DATABASE_KEY_STORAGE_KEY);
    expect(device.files.get(LEGACY_DATABASE_NAME)).toBe(KEY_1);
    expect(device.files.get(athleteDatabaseName(A))).toBe(aFile);
    expect(device.keys.get(athleteDatabaseKeyStorageKey(A))).toBe(aKey);
  });
});
