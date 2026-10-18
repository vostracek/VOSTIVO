import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSupabaseClientConfig, MissingSupabaseConfigError } from "./supabase-config.js";

describe("mobile Supabase client-safe config boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads url and anon key from EXPO_PUBLIC_-prefixed vars only", () => {
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_URL", "https://test-project.supabase.co");
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");

    expect(loadSupabaseClientConfig()).toEqual({
      url: "https://test-project.supabase.co",
      anonKey: "test-anon-key",
    });
  });

  it("fails fast, naming exactly what's missing, rather than silently proceeding", () => {
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY", undefined);

    expect(() => loadSupabaseClientConfig()).toThrow(MissingSupabaseConfigError);
  });
});
