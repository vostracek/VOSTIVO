import { describe, expect, it } from "vitest";
import { engineVersionsEqual, formatEngineVersion } from "./engine-version.js";
import type { EnginePolicy } from "./decision.js";

/**
 * Placeholder policy used only to prove the determinism contract:
 * same input + same engine/policy version => same output. Real policies
 * (progression, deload, ...) are out of scope for Foundation Bootstrap.
 */
const echoPolicy: EnginePolicy<{ value: number }, "echo", { value: number }> = {
  version: { engine: "bootstrap-echo", policy: "v1" },
  decide(input) {
    return {
      kind: "echo",
      version: echoPolicy.version,
      data: { value: input.value },
      reason: "bootstrap placeholder: echoes input unchanged",
    };
  },
};

describe("training-engine determinism contract", () => {
  it("produces an identical decision for identical input under the same version", () => {
    const input = { value: 7 };
    const first = echoPolicy.decide(input);
    const second = echoPolicy.decide({ value: 7 });

    expect(first).toEqual(second);
    expect(engineVersionsEqual(first.version, second.version)).toBe(true);
  });

  it("formats an engine version as engine@policy", () => {
    expect(formatEngineVersion({ engine: "progression", policy: "v3" })).toBe("progression@v3");
  });

  it("has no framework or infrastructure dependency at the type level", () => {
    // If this package ever imports drizzle/@nestjs/react/etc, the
    // dependency-cruiser boundary check (pnpm boundaries:check) fails the build.
    expect(typeof echoPolicy.decide).toBe("function");
  });
});
