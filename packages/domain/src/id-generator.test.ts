import { describe, expect, it } from "vitest";
import { createEntityId } from "./entity-id.js";
import { configureDomainIdGenerator, generateDomainId } from "./id-generator.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("domain ID generation — default (native Web Crypto) path", () => {
  it("generates a valid UUIDv7 string by default, with no configuration required", () => {
    const id = createEntityId<"Test">();
    expect(id).toMatch(UUID_V7_PATTERN);
  });

  it("produces unique IDs over a reasonable batch", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => createEntityId<"Test">()));
    expect(ids.size).toBe(5000);
  });
});

describe("domain ID generation — explicitly configured random source", () => {
  it("uses the configured source instead of the default, and still produces valid UUIDv7", () => {
    let calls = 0;
    configureDomainIdGenerator({
      nextUint32: () => {
        calls += 1;
        // A real secure RNG would return unpredictable values; this fixed
        // value is only to prove the source is actually being called.
        return 0x12345678;
      },
    });

    const id = generateDomainId();

    expect(calls).toBeGreaterThan(0);
    expect(id).toMatch(UUID_V7_PATTERN);
  });

  it("produces unique IDs even under a configured source (time + monotonic counter, not just RNG)", () => {
    configureDomainIdGenerator({ nextUint32: () => 0xaaaaaaaa });
    const ids = new Set(Array.from({ length: 1000 }, () => generateDomainId()));
    expect(ids.size).toBe(1000);
  });
});
