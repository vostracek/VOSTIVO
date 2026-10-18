import { describe, expect, it } from "vitest";
import { apiConfigSchema, loadApiConfig } from "./api-config.js";

const REQUIRED = {
  NODE_ENV: "local",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  SUPABASE_URL: "https://project.supabase.co",
};

describe("apiConfigSchema — rate limiting / trust proxy", () => {
  it("defaults to a generous rate limit when unset (Security Hardening Follow-Up V1)", () => {
    const config = loadApiConfig(REQUIRED);
    // Sized well above realistic V1 mobile traffic (Plan/Preview/me plus
    // sync reconnect bursts) — a regression here would silently make the
    // API unusably strict for legitimate offline-sync catch-up.
    expect(config.RATE_LIMIT_MAX).toBeGreaterThanOrEqual(100);
    expect(config.RATE_LIMIT_WINDOW_SECONDS).toBeGreaterThanOrEqual(30);
  });

  it("is environment-configurable", () => {
    const config = loadApiConfig({ ...REQUIRED, RATE_LIMIT_MAX: "50", RATE_LIMIT_WINDOW_SECONDS: "10" });
    expect(config.RATE_LIMIT_MAX).toBe(50);
    expect(config.RATE_LIMIT_WINDOW_SECONDS).toBe(10);
  });

  it("defaults TRUST_PROXY to false — never trusts a forwarded header until a real proxy topology is chosen", () => {
    const config = loadApiConfig(REQUIRED);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it("parses TRUST_PROXY=true explicitly, and rejects a non-boolean value instead of silently coercing it", () => {
    expect(loadApiConfig({ ...REQUIRED, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(() => apiConfigSchema.parse({ ...REQUIRED, TRUST_PROXY: "yes" })).toThrow();
  });
});
