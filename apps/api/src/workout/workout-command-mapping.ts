import type { StartWorkoutSessionCommandV1, WorkoutCommandV1 } from "@vostivo/contracts";
import { validateAvailableTimeApplication, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { WorkoutCommandDto } from "./dto/workout-command.dto.js";

/**
 * class-validator (WorkoutCommandDto) checks per-field *shape*; this
 * checks per-type *completeness* — which class-validator alone cannot
 * express ("these fields are required only when `type` is X"). Returns
 * `null` for a structurally incomplete command; the caller reports that
 * as REJECTED without ever touching the database (spec section 22/27).
 */
export function toWorkoutCommandV1(dto: WorkoutCommandDto): WorkoutCommandV1 | null {
  switch (dto.type) {
    case "START_WORKOUT_SESSION_V1": {
      if (
        dto.workoutSessionId === undefined ||
        dto.prescription === undefined ||
        dto.startedAt === undefined ||
        !isPrescriptionShapeValid(dto.prescription)
      ) {
        return null;
      }
      const start: StartWorkoutSessionCommandV1 = {
        commandId: dto.commandId,
        type: "START_WORKOUT_SESSION_V1",
        schemaVersion: 1,
        createdAt: dto.createdAt,
        workoutSessionId: dto.workoutSessionId,
        // Stored/consumed as an opaque, versioned document — see
        // docs/architecture/WORKOUT-DATA-INTEGRITY.md for why deep
        // per-field validation of the snapshot is deferred.
        prescription: dto.prescription as unknown as WorkoutPrescriptionV1,
        startedAt: dto.startedAt,
      };
      // Available-Time Adaptation V1 Slice C: absent on an ordinary START,
      // which therefore maps exactly as before. A present-but-malformed one
      // makes the whole command malformed (REJECTED), never silently dropped.
      if (dto.availableTimeApplication === undefined) return start;
      const application = validateAvailableTimeApplication(dto.availableTimeApplication);
      return application.ok ? { ...start, availableTimeApplication: application.value } : null;
    }
    case "COMPLETE_SET_V1": {
      if (
        dto.workoutSessionId === undefined ||
        dto.performedExerciseId === undefined ||
        dto.exerciseRef === undefined ||
        dto.exerciseDisplayName === undefined ||
        dto.exerciseOrder === undefined ||
        dto.performedSetId === undefined ||
        dto.setOrder === undefined ||
        dto.actualReps === undefined ||
        dto.actualLoad === undefined ||
        dto.setType === undefined ||
        dto.revision === undefined ||
        dto.completedAt === undefined ||
        dto.sessionSeq === undefined
      ) {
        return null;
      }
      return {
        commandId: dto.commandId,
        type: "COMPLETE_SET_V1",
        schemaVersion: 1,
        createdAt: dto.createdAt,
        workoutSessionId: dto.workoutSessionId,
        performedExerciseId: dto.performedExerciseId,
        prescriptionExerciseId: dto.prescriptionExerciseId ?? null,
        exerciseRef: dto.exerciseRef,
        exerciseDisplayName: dto.exerciseDisplayName,
        exerciseOrder: dto.exerciseOrder,
        performedSetId: dto.performedSetId,
        prescriptionSetId: dto.prescriptionSetId ?? null,
        setOrder: dto.setOrder,
        actualReps: dto.actualReps,
        actualLoad: dto.actualLoad,
        setType: dto.setType,
        revision: dto.revision,
        completedAt: dto.completedAt,
        sessionSeq: dto.sessionSeq,
      };
    }
    case "REOPEN_SET_V1": {
      if (dto.performedSetId === undefined || dto.revision === undefined || dto.sessionSeq === undefined) {
        return null;
      }
      return {
        commandId: dto.commandId,
        type: "REOPEN_SET_V1",
        schemaVersion: 1,
        createdAt: dto.createdAt,
        performedSetId: dto.performedSetId,
        revision: dto.revision,
        sessionSeq: dto.sessionSeq,
      };
    }
    case "FINISH_WORKOUT_SESSION_V1": {
      if (dto.workoutSessionId === undefined || dto.completedAt === undefined || dto.finishSeq === undefined) {
        return null;
      }
      return {
        commandId: dto.commandId,
        type: "FINISH_WORKOUT_SESSION_V1",
        schemaVersion: 1,
        createdAt: dto.createdAt,
        workoutSessionId: dto.workoutSessionId,
        completedAt: dto.completedAt,
        finishSeq: dto.finishSeq,
      };
    }
  }
}

function isPrescriptionShapeValid(value: Record<string, unknown>): boolean {
  return (
    value["schemaVersion"] === 1 &&
    typeof value["prescriptionId"] === "string" &&
    typeof value["name"] === "string" &&
    Array.isArray(value["exercises"])
  );
}
