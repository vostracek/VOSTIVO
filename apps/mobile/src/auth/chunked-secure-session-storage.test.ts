import { describe, expect, it } from "vitest";
import { SessionStorageUnavailableError } from "../identity/auth-session";
import { InMemorySecureValueStore } from "../identity/testing/fakes";
import { ChunkedSecureSessionStorage, SESSION_CHUNK_SIZE } from "./chunked-secure-session-storage";

const KEY = "supabase-session";
const MANIFEST = "vostivo.auth.supabase-session.manifest";

/** A realistic Supabase session payload: well above one SecureStore value. */
function sessionJson(marker: string): string {
  return JSON.stringify({ access_token: `${marker}.${"a".repeat(1200)}`, refresh_token: `${marker}-refresh`, user: { id: `user-${marker}`, email: "x@example.com", app_metadata: { pad: "p".repeat(2500) } } });
}

describe("ChunkedSecureSessionStorage", () => {
  it("AUTH-006: round-trips a multi-chunk session; every SecureStore value stays below the chunk size; keys are SecureStore-safe", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    const value = sessionJson("one");
    await storage.setItem(KEY, value);

    expect(await storage.getItem(KEY)).toBe(value);
    // A fresh instance over the same keystore (= app relaunch) restores it.
    expect(await new ChunkedSecureSessionStorage(store).getItem(KEY)).toBe(value);
    expect(store.values.size).toBeGreaterThan(2);
    for (const [key, stored] of store.values) {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(stored.length).toBeLessThanOrEqual(SESSION_CHUNK_SIZE);
    }
    // The manifest is written LAST.
    expect(store.writes[store.writes.length - 1]).toBe(MANIFEST);
  });

  it("AUTH-007: a write interrupted before the manifest switch keeps the previous generation fully readable", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    const previous = sessionJson("old");
    await storage.setItem(KEY, previous);

    store.failSetsAfter = 1; // one chunk of the new generation lands, then the "process dies"
    await expect(storage.setItem(KEY, sessionJson("new"))).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    store.failSetsAfter = null;

    expect(await storage.getItem(KEY)).toBe(previous);
    // The next successful write still works and cleans the old generation.
    const next = sessionJson("next");
    await storage.setItem(KEY, next);
    expect(await storage.getItem(KEY)).toBe(next);
    expect([...store.values.keys()].filter((key) => key.includes(".g1."))).toEqual([]);
  });

  it("AUTH-008: a missing chunk fails closed (no session), never a partial session", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    await storage.setItem(KEY, sessionJson("one"));
    store.values.delete("vostivo.auth.supabase-session.g1.1");
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("AUTH-008: a corrupted chunk / manifest fails closed", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    await storage.setItem(KEY, sessionJson("one"));
    const chunk = "vostivo.auth.supabase-session.g1.0";
    store.values.set(chunk, `X${store.values.get(chunk)!.slice(1)}`);
    expect(await storage.getItem(KEY)).toBeNull();

    store.values.set(MANIFEST, "{not json");
    expect(await storage.getItem(KEY)).toBeNull();
    store.values.set(MANIFEST, JSON.stringify({ v: 2, generation: 1, chunks: 1, length: 1, checksum: "0" }));
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("removeItem drops the manifest first and every chunk", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    await storage.setItem(KEY, sessionJson("one"));
    await storage.removeItem(KEY);
    expect(store.deletes[0]).toBe(MANIFEST);
    expect(store.values.size).toBe(0);
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("AUTH-022: an unavailable keystore is a typed SessionStorageUnavailableError — never null ('signed out')", async () => {
    const store = new InMemorySecureValueStore();
    const storage = new ChunkedSecureSessionStorage(store);
    await storage.setItem(KEY, sessionJson("one"));
    store.unavailable = true;
    await expect(storage.getItem(KEY)).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    await expect(storage.setItem(KEY, "x")).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    store.unavailable = false;
    expect(store.deletes).toEqual([]);
    expect(await storage.getItem(KEY)).toBe(sessionJson("one"));
  });
});
