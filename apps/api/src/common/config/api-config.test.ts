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

describe("apiConfigSchema — VOSTIVO_DATA_ENV (Dogfood Environment V1)", () => {
  it("is optional and accepts only dev/manual/dogfood", () => {
    expect(loadApiConfig(REQUIRED).VOSTIVO_DATA_ENV).toBeUndefined();
    expect(loadApiConfig({ ...REQUIRED, VOSTIVO_DATA_ENV: "dogfood", HOST: "127.0.0.1" }).VOSTIVO_DATA_ENV).toBe("dogfood");
    expect(() => apiConfigSchema.parse({ ...REQUIRED, VOSTIVO_DATA_ENV: "prod" })).toThrow();
  });

  it("refuses LOCAL_JWKS_PATH together with VOSTIVO_DATA_ENV=dogfood (real Supabase tokens only)", () => {
    expect(() => apiConfigSchema.parse({ ...REQUIRED, VOSTIVO_DATA_ENV: "dogfood", HOST: "127.0.0.1", LOCAL_JWKS_PATH: "/tmp/jwks.json" })).toThrow(/LOCAL_JWKS_PATH/);
    expect(() => apiConfigSchema.parse({ ...REQUIRED, VOSTIVO_DATA_ENV: "manual", LOCAL_JWKS_PATH: "/tmp/jwks.json" })).not.toThrow();
  });
});

describe("apiConfigSchema — HOST bind address (Dogfood Environment V1)", () => {
  const DOGFOOD = { ...REQUIRED, VOSTIVO_DATA_ENV: "dogfood" };

  it("defaults to 0.0.0.0, unchanged for existing dev/manual setups", () => {
    expect(loadApiConfig(REQUIRED).HOST).toBe("0.0.0.0");
    expect(loadApiConfig({ ...REQUIRED, VOSTIVO_DATA_ENV: "manual" }).HOST).toBe("0.0.0.0");
  });

  it("accepts the dogfood runtime config: HOST=127.0.0.1, PORT=4100", () => {
    const config = loadApiConfig({ ...DOGFOOD, HOST: "127.0.0.1", PORT: "4100" });
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(4100);
    expect(loadApiConfig({ ...DOGFOOD, HOST: "::1" }).HOST).toBe("::1");
  });

  it("refuses dogfood on any non-loopback interface, including the default", () => {
    for (const host of [undefined, "0.0.0.0", "::", "192.168.1.20"]) {
      expect(() => apiConfigSchema.parse({ ...DOGFOOD, HOST: host })).toThrow(/HOST=127\.0\.0\.1/);
    }
  });

  it("rejects a value that is not an IP address", () => {
    expect(() => apiConfigSchema.parse({ ...REQUIRED, HOST: "localhost" })).toThrow();
    expect(() => apiConfigSchema.parse({ ...REQUIRED, HOST: "0.0.0.0; rm" })).toThrow();
  });
});
