import { describe, expect, it } from "vitest";
import { ConfigValidationError } from "@vostivo/config";
import { loadWorkerConfig, workerConfigSchema } from "./worker-config.js";

const REQUIRED = {
  NODE_ENV: "local",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
};

describe("workerConfigSchema", () => {
  it("loads successfully with a valid DATABASE_URL", () => {
    const config = loadWorkerConfig(REQUIRED);
    expect(config.DATABASE_URL).toBe(REQUIRED.DATABASE_URL);
    expect(config.NODE_ENV).toBe("local");
  });

  it("fails fast (never boots with broken config) when DATABASE_URL is missing", () => {
    expect(() => loadWorkerConfig({ NODE_ENV: "local" })).toThrow(ConfigValidationError);
  });

  it("rejects a non-URL DATABASE_URL rather than silently accepting a malformed connection string", () => {
    expect(() => workerConfigSchema.parse({ ...REQUIRED, DATABASE_URL: "not-a-url" })).toThrow();
  });
});

describe("workerConfigSchema — VOSTIVO_DATA_ENV (Dogfood Environment V1)", () => {
  it("is optional and accepts only dev/manual/dogfood", () => {
    expect(loadWorkerConfig(REQUIRED).VOSTIVO_DATA_ENV).toBeUndefined();
    expect(loadWorkerConfig({ ...REQUIRED, VOSTIVO_DATA_ENV: "dogfood" }).VOSTIVO_DATA_ENV).toBe("dogfood");
    expect(() => workerConfigSchema.parse({ ...REQUIRED, VOSTIVO_DATA_ENV: "prod" })).toThrow();
  });
});
