import { describe, expect, it } from "vitest";
import { createEntityId } from "../entity-id.js";
import type { PlannedWorkout } from "./planned-workout.js";
import { deriveSessionDisplayStatus } from "./session-status-projection.js";

function buildPlannedWorkout(overrides: Partial<PlannedWorkout> = {}): PlannedWorkout {
  const now = new Date();
  return {
    id: createEntityId(),
    trainingCycleId: createEntityId(),
    name: "Upper Body A",
    focus: null,
    order: 1,
    scheduledDate: "2026-09-03",
    estimatedDurationMinutes: 60,
    status: "PLANNED",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("deriveSessionDisplayStatus", () => {
  it("PLAN-API-004: a COMPLETED WorkoutSession takes priority over scheduling status", () => {
    const workout = buildPlannedWorkout();

    const status = deriveSessionDisplayStatus(workout, { status: "COMPLETED" }, "2026-09-03");

    expect(status).toBe("COMPLETED");
  });

  it("an ACTIVE WorkoutSession maps to IN_PROGRESS regardless of scheduling status", () => {
    const workout = buildPlannedWorkout({ status: "SKIPPED" });

    const status = deriveSessionDisplayStatus(workout, { status: "ACTIVE" }, "2026-09-03");

    expect(status).toBe("IN_PROGRESS");
  });

  it("without a matching session, scheduling status wins over the date", () => {
    const workout = buildPlannedWorkout({ status: "CANCELLED", scheduledDate: "2026-09-03" });

    const status = deriveSessionDisplayStatus(workout, undefined, "2026-09-03");

    expect(status).toBe("CANCELLED");
  });

  it("without a matching session or special status, today's date maps to TODAY", () => {
    const workout = buildPlannedWorkout({ scheduledDate: "2026-09-03" });

    expect(deriveSessionDisplayStatus(workout, undefined, "2026-09-03")).toBe("TODAY");
    expect(deriveSessionDisplayStatus(workout, undefined, "2026-09-04")).toBe("PLANNED");
  });
});
