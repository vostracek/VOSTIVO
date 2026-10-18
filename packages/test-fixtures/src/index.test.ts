import { describe, expect, it } from "vitest";
import { FIXED_TEST_CORRELATION_ID } from "./correlation-id.js";

describe("test-fixtures package", () => {
  it("exposes a stable, deterministic fixture value", () => {
    expect(FIXED_TEST_CORRELATION_ID).toBe(FIXED_TEST_CORRELATION_ID);
    expect(typeof FIXED_TEST_CORRELATION_ID).toBe("string");
  });
});
