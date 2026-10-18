import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDomainId } from "./id-generator.js";

/**
 * Deliberately its own file: vitest isolates module state per test file, so
 * this exercises `generateDomainId()` before anything in this process could
 * have called `configureDomainIdGenerator()` — proving the "neither
 * configured nor native Web Crypto" case fails loudly instead of silently
 * degrading to `Math.random()` or UUIDv4.
 */
describe("domain ID generation — no secure source available", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws rather than silently falling back to Math.random or UUIDv4", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => generateDomainId()).toThrow(/secure random source/i);
  });
});
