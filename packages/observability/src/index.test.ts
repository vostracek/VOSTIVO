import { describe, expect, it } from "vitest";
import { createCorrelationId } from "./correlation-id.js";
import { createLogger } from "./logger.js";

describe("observability boundary", () => {
  it("creates unique correlation ids", () => {
    expect(createCorrelationId()).not.toEqual(createCorrelationId());
  });

  it("creates a logger that exposes only the vendor-agnostic interface", () => {
    const logger = createLogger({ serviceName: "test", level: "error" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
    // Should not throw even though nothing is asserted about pino internals.
    logger.child({ requestId: "r-1" }).error("smoke test");
  });
});
