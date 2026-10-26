import { describe, expect, it } from "vitest";
import { MissingSupabaseConfigError, parseSupabaseClientConfig, SupabaseConfigError } from "./supabase-config.js";

const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");

describe("mobile Supabase client-safe config boundary (Auth Slice C)", () => {
  it("reads the project URL and the PUBLISHABLE key", () => {
    expect(parseSupabaseClientConfig({ url: "https://test-project.supabase.co/", publishableKey: "sb_publishable_abc" })).toEqual({
      url: "https://test-project.supabase.co",
      publishableKey: "sb_publishable_abc",
    });
  });

  it("not configured at all -> null (the wiring decides what that means)", () => {
    expect(parseSupabaseClientConfig({ url: undefined, publishableKey: "" })).toBeNull();
  });

  it("a half configuration fails fast, naming exactly what is missing", () => {
    expect(() => parseSupabaseClientConfig({ url: "https://test-project.supabase.co", publishableKey: undefined })).toThrow(MissingSupabaseConfigError);
    expect(() => parseSupabaseClientConfig({ url: "https://test-project.supabase.co", publishableKey: undefined })).toThrow(/EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("refuses a secret key or a legacy service_role JWT under the publishable name (never in the mobile app)", () => {
    expect(() => parseSupabaseClientConfig({ url: "https://p.supabase.co", publishableKey: "sb_secret_xyz" })).toThrow(SupabaseConfigError);
    const serviceRole = `${encode({ alg: "HS256" })}.${encode({ role: "service_role" })}.sig`;
    expect(() => parseSupabaseClientConfig({ url: "https://p.supabase.co", publishableKey: serviceRole })).toThrow(SupabaseConfigError);
    const anon = `${encode({ alg: "HS256" })}.${encode({ role: "anon" })}.sig`;
    expect(parseSupabaseClientConfig({ url: "https://p.supabase.co", publishableKey: anon })?.publishableKey).toBe(anon);
  });

  it("requires https except for a local Supabase", () => {
    expect(() => parseSupabaseClientConfig({ url: "http://p.supabase.co", publishableKey: "sb_publishable_abc" })).toThrow(SupabaseConfigError);
    expect(parseSupabaseClientConfig({ url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_abc" })?.url).toBe("http://127.0.0.1:54321");
  });

  it("error messages never contain the key value", () => {
    try {
      parseSupabaseClientConfig({ url: "https://p.supabase.co", publishableKey: "sb_secret_DO_NOT_LEAK" });
    } catch (error) {
      expect(String(error)).not.toContain("DO_NOT_LEAK");
    }
  });
});
