import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeferredSupabaseAuthTokenProvider, StaticTestAuthTokenProvider } from "../workout/auth-token-provider";
import { createPlanAuthTokenProvider } from "./plan-runtime-config";

const ENV_KEYS = ["EXPO_PUBLIC_VOSTIVO_ENV", "EXPO_PUBLIC_DEV_JWT"] as const;
let originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  originalValues = {};
  for (const key of ENV_KEYS) originalValues[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

describe("createPlanAuthTokenProvider — production auth-override guard", () => {
  it("with no env vars set, resolves to the deferred (throws-loudly) production provider", () => {
    delete process.env.EXPO_PUBLIC_VOSTIVO_ENV;
    delete process.env.EXPO_PUBLIC_DEV_JWT;

    expect(createPlanAuthTokenProvider()).toBeInstanceOf(DeferredSupabaseAuthTokenProvider);
  });

  it("rejects a dev JWT configured while the environment resolves to production (explicit)", () => {
    process.env.EXPO_PUBLIC_VOSTIVO_ENV = "production";
    process.env.EXPO_PUBLIC_DEV_JWT = "some-token";

    expect(() => createPlanAuthTokenProvider()).toThrow(/production/i);
  });

  it("rejects a dev JWT configured while the environment is unset (fails closed to production)", () => {
    delete process.env.EXPO_PUBLIC_VOSTIVO_ENV;
    process.env.EXPO_PUBLIC_DEV_JWT = "some-token";

    expect(() => createPlanAuthTokenProvider()).toThrow(/production/i);
  });

  it("rejects a dev JWT configured while the environment is an unrecognized value (fails closed to production)", () => {
    process.env.EXPO_PUBLIC_VOSTIVO_ENV = "not-a-real-environment";
    process.env.EXPO_PUBLIC_DEV_JWT = "some-token";

    expect(() => createPlanAuthTokenProvider()).toThrow(/production/i);
  });

  it("activates the override only with both an explicit non-production environment AND a token", () => {
    process.env.EXPO_PUBLIC_VOSTIVO_ENV = "local";
    process.env.EXPO_PUBLIC_DEV_JWT = "some-token";

    const provider = createPlanAuthTokenProvider();

    expect(provider).toBeInstanceOf(StaticTestAuthTokenProvider);
  });

  it("a non-production environment with no token still uses the deferred provider", () => {
    process.env.EXPO_PUBLIC_VOSTIVO_ENV = "development";
    delete process.env.EXPO_PUBLIC_DEV_JWT;

    expect(createPlanAuthTokenProvider()).toBeInstanceOf(DeferredSupabaseAuthTokenProvider);
  });
});
