import { describe, expect, it } from "vitest";
import type { AvailableTimeApplicationV1 } from "@vostivo/domain";
import type { WorkoutCommandDto } from "./dto/workout-command.dto.js";
import { toWorkoutCommandV1 } from "./workout-command-mapping.js";

function id(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

const APPLICATION: AvailableTimeApplicationV1 = {
  schemaVersion: 1,
  scope: "TODAY_ONLY",
  policyVersion: "available-time/v1",
  plannedWorkoutId: id(1),
  sourceProgramVersionId: id(2),
  availableMinutes: 8,
  previewFingerprint: "d".repeat(64),
  originalEstimatedSeconds: 540,
  adjustedEstimatedSeconds: 420,
  exercises: [{ plannedExerciseId: id(10), retainedPlannedSetIds: [id(101)], removedPlannedSetIds: [id(102)] }],
};

function startDto(overrides: Partial<WorkoutCommandDto> = {}): WorkoutCommandDto {
  return Object.assign(
    {
      commandId: id(900),
      type: "START_WORKOUT_SESSION_V1",
      schemaVersion: 1,
      createdAt: "2026-10-05T10:00:00.000Z",
      workoutSessionId: id(901),
      prescription: { schemaVersion: 1, prescriptionId: id(1), name: "Upper Body A", exercises: [] },
      startedAt: "2026-10-05T10:00:00.000Z",
    } as WorkoutCommandDto,
    overrides,
  );
}

describe("toWorkoutCommandV1 — START with optional Available-Time application", () => {
  it("an ordinary START maps exactly as before, with no availableTimeApplication key", () => {
    const command = toWorkoutCommandV1(startDto());
    expect(command).not.toBeNull();
    expect(command && "availableTimeApplication" in command).toBe(false);
  });

  it("a well-formed application is carried through, validated", () => {
    const command = toWorkoutCommandV1(startDto({ availableTimeApplication: { ...APPLICATION } as unknown as Record<string, unknown> }));
    expect(command).toMatchObject({ type: "START_WORKOUT_SESSION_V1", availableTimeApplication: APPLICATION });
  });

  it.each([
    ["an unknown policy version", { ...APPLICATION, policyVersion: "available-time/v9" }],
    ["a non-TODAY_ONLY scope", { ...APPLICATION, scope: "PERMANENT" }],
    ["an impossible partition", { ...APPLICATION, exercises: [{ plannedExerciseId: id(10), retainedPlannedSetIds: [id(101)], removedPlannedSetIds: [id(101)] }] }],
    ["a CANNOT_FIT-like application that does not fit the budget", { ...APPLICATION, adjustedEstimatedSeconds: 600, originalEstimatedSeconds: 700 }],
  ])("a malformed application (%s) makes the whole command malformed -> REJECTED upstream", (_label, application) => {
    expect(toWorkoutCommandV1(startDto({ availableTimeApplication: application as unknown as Record<string, unknown> }))).toBeNull();
  });
});
