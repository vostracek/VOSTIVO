import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseConfigSchema, ConfigValidationError, loadConfig } from "./load-config.js";
import { isProduction } from "./environment.js";

describe("typed environment config", () => {
  it("defaults NODE_ENV to local when unset", () => {
    const config = loadConfig(baseConfigSchema, {});
    expect(config.NODE_ENV).toBe("local");
  });

  it("fails fast on an invalid environment name instead of accepting a typo", () => {
    expect(() => loadConfig(baseConfigSchema, { NODE_ENV: "prod" })).toThrow(ConfigValidationError);
  });

  it("lets a service extend the base schema with its own required variables", () => {
    const apiSchema = baseConfigSchema.extend({
      PORT: z.coerce.number().int().positive(),
    });

    expect(() => loadConfig(apiSchema, { NODE_ENV: "local" })).toThrow(ConfigValidationError);

    const config = loadConfig(apiSchema, { NODE_ENV: "local", PORT: "4000" });
    expect(config.PORT).toBe(4000);
  });

  it("treats only production as production", () => {
    expect(isProduction("production")).toBe(true);
    expect(isProduction("staging")).toBe(false);
  });
});
