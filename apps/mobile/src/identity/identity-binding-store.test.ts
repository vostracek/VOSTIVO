import { describe, expect, it } from "vitest";
import { IDENTITY_BINDINGS_STORAGE_KEY, IdentityBindingConflictError, IdentityBindingStore, MAX_IDENTITY_BINDINGS } from "./identity-binding-store";
import { InMemorySecureValueStore } from "./testing/fakes";

const A = { userId: "0190a000-0000-7000-8000-00000000000a", athleteProfileId: "0190a000-0000-7000-8000-0000000000aa" };
const B = { userId: "0190a000-0000-7000-8000-00000000000b", athleteProfileId: "0190a000-0000-7000-8000-0000000000bb" };
const NOW = new Date("2026-10-19T10:00:00.000Z");

describe("IdentityBindingStore", () => {
  it("records a verified binding and finds it only by the exact (provider, subject)", async () => {
    const store = new IdentityBindingStore(new InMemorySecureValueStore());
    await store.recordVerified("supabase", "sub-a", A, NOW);

    expect(await store.find("supabase", "sub-a")).toEqual({ provider: "supabase", providerSubject: "sub-a", ...A, verifiedAt: NOW.toISOString() });
    expect(await store.find("supabase", "sub-b")).toBeNull();
    expect(await store.find("other", "sub-a")).toBeNull();
  });

  it("re-verifying the same user is idempotent (one binding, refreshed verifiedAt)", async () => {
    const secure = new InMemorySecureValueStore();
    const store = new IdentityBindingStore(secure);
    await store.recordVerified("supabase", "sub-a", A, NOW);
    const later = new Date("2026-10-20T10:00:00.000Z");
    await store.recordVerified("supabase", "sub-a", A, later);

    expect(JSON.parse(secure.values.get(IDENTITY_BINDINGS_STORAGE_KEY)!).bindings).toEqual([{ provider: "supabase", providerSubject: "sub-a", ...A, verifiedAt: later.toISOString() }]);
  });

  it("GATE-9: the same subject resolving to a DIFFERENT userId is a conflict — nothing is written, the original binding stays", async () => {
    const secure = new InMemorySecureValueStore();
    const store = new IdentityBindingStore(secure);
    await store.recordVerified("supabase", "sub-a", A, NOW);
    const before = secure.values.get(IDENTITY_BINDINGS_STORAGE_KEY);

    await expect(store.recordVerified("supabase", "sub-a", B, NOW)).rejects.toBeInstanceOf(IdentityBindingConflictError);
    expect(secure.values.get(IDENTITY_BINDINGS_STORAGE_KEY)).toBe(before);
    expect((await store.find("supabase", "sub-a"))?.userId).toBe(A.userId);
  });

  it("keeps at most MAX_IDENTITY_BINDINGS, evicting the least recently verified", async () => {
    const store = new IdentityBindingStore(new InMemorySecureValueStore());
    for (let index = 0; index <= MAX_IDENTITY_BINDINGS; index++) {
      const userId = `0190a000-0000-7000-8000-${String(index).padStart(12, "0")}`;
      await store.recordVerified("supabase", `sub-${index}`, { userId, athleteProfileId: userId }, new Date(NOW.getTime() + index * 1000));
    }
    expect(await store.find("supabase", "sub-0")).toBeNull();
    expect(await store.find("supabase", `sub-${MAX_IDENTITY_BINDINGS}`)).not.toBeNull();
    expect(await store.find("supabase", "sub-1")).not.toBeNull();
  });

  it("an unreadable stored item is 'no bindings' (fail closed) — never a guessed identity", async () => {
    const secure = new InMemorySecureValueStore();
    secure.values.set(IDENTITY_BINDINGS_STORAGE_KEY, "{not json");
    expect(await new IdentityBindingStore(secure).find("supabase", "sub-a")).toBeNull();
    secure.values.set(IDENTITY_BINDINGS_STORAGE_KEY, JSON.stringify({ version: 1, bindings: [{ provider: "supabase", providerSubject: "sub-a" }] }));
    expect(await new IdentityBindingStore(secure).find("supabase", "sub-a")).toBeNull();
  });
});
