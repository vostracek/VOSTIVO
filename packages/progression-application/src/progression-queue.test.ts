import { describe, expect, it } from "vitest";
import { progressionEvaluateSessionJobPayloadV1Schema } from "./progression-queue.js";

describe("progressionEvaluateSessionJobPayloadV1Schema", () => {
  it("accepts a minimal, non-sensitive payload", () => {
    const result = progressionEvaluateSessionJobPayloadV1Schema.safeParse({
      workoutSessionId: "session-1",
      triggerCommandId: "command-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload carrying an untrusted userId field beyond the schema (stripped, not an error, by zod's default object parsing) — but rejects a missing required field", () => {
    const missingField = progressionEvaluateSessionJobPayloadV1Schema.safeParse({ workoutSessionId: "session-1" });
    expect(missingField.success).toBe(false);
  });

  it("never includes a userId or full snapshot in its shape", () => {
    const shapeKeys = Object.keys(progressionEvaluateSessionJobPayloadV1Schema.shape);
    expect(shapeKeys).toEqual(["workoutSessionId", "triggerCommandId"]);
  });
});
