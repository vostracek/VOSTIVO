import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { SET_TYPES, WORKOUT_COMMAND_TYPES, type SetType, type WorkoutCommandType } from "@vostivo/domain";
import { ExternalWeightLoadDto } from "./external-weight-load.dto.js";

/**
 * A deliberately flattened DTO covering all three command types (spec
 * section 18) rather than a class-validator discriminated union — with
 * only three variants, "every possible field, each `@IsOptional()`, typed
 * per-field" is simpler to get right than polymorphic validation
 * plumbing. Structural per-field validation happens here; per-type
 * *completeness* (which fields are actually required for this command's
 * `type`) is checked explicitly in `assertCommandShapeForType()` below —
 * class-validator alone cannot express "these fields are required only
 * when `type` is X."
 *
 * The nested `prescription` snapshot is intentionally validated only at
 * the top level here (is it a non-null object) — deep per-field
 * validation of every exercise/set inside it is deferred; the snapshot is
 * stored as an opaque, versioned document (see
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md).
 */
export class WorkoutCommandDto {
  @IsUUID(7)
  commandId!: string;

  @IsIn(WORKOUT_COMMAND_TYPES)
  type!: WorkoutCommandType;

  @IsIn([1])
  schemaVersion!: 1;

  @IsISO8601()
  createdAt!: string;

  // START_WORKOUT_SESSION_V1
  @IsOptional()
  @IsUUID(7)
  workoutSessionId?: string;

  @IsOptional()
  @IsObject()
  prescription?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  /**
   * Available-Time Adaptation V1 Slice C — optional, START only. Structure
   * is validated by the domain's `validateAvailableTimeApplication` in
   * `toWorkoutCommandV1` (a malformed one makes the whole command
   * malformed -> REJECTED), ownership/integrity in the START handler.
   */
  @IsOptional()
  @IsObject()
  availableTimeApplication?: Record<string, unknown>;

  // COMPLETE_SET_V1
  @IsOptional()
  @IsUUID(7)
  performedExerciseId?: string;

  @IsOptional()
  @IsString()
  prescriptionExerciseId?: string | null;

  // COMPLETE_SET_V1 — the stable cross-session catalog pointer, now
  // synchronized canonical server workout reality (see
  // docs/domain/PROGRESSION-ENGINE-V1.md §25/OD-1, §29 correction).
  // Required, never null (Exercise Ref Legacy Reconciliation) — unlike
  // `prescriptionExerciseId`, a missing/null value here is rejected by
  // `assertCommandShapeForType()`'s completeness check, not treated as a
  // meaningful "no identity" value. `@IsOptional()` here follows this
  // DTO's flattened per-field convention (see class doc comment); it does
  // not mean this field is optional for COMPLETE_SET_V1.
  @IsOptional()
  @IsString()
  exerciseRef?: string;

  @IsOptional()
  @IsString()
  exerciseDisplayName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  exerciseOrder?: number;

  @IsOptional()
  @IsUUID(7)
  performedSetId?: string;

  @IsOptional()
  @IsString()
  prescriptionSetId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  setOrder?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  actualReps?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalWeightLoadDto)
  actualLoad?: ExternalWeightLoadDto;

  @IsOptional()
  @IsISO8601()
  completedAt?: string;

  // COMPLETE_SET_V1 — required, always explicit; the server never infers
  // set type from any other field (Progression Prerequisites V1).
  @IsOptional()
  @IsIn(SET_TYPES)
  setType?: SetType;

  // COMPLETE_SET_V1 and REOPEN_SET_V1
  @IsOptional()
  @IsInt()
  @Min(1)
  revision?: number;

  // COMPLETE_SET_V1 and REOPEN_SET_V1 — the Finish causal boundary
  // (Active Workout Finish Causal Boundary Fix). Integer only — never a
  // floating-point sequence value.
  @IsOptional()
  @IsInt()
  @Min(1)
  sessionSeq?: number;

  // FINISH_WORKOUT_SESSION_V1 — the watermark itself. 0 is valid (no set
  // mutation was ever issued for this session before it was finished).
  @IsOptional()
  @IsInt()
  @Min(0)
  finishSeq?: number;
}

/**
 * Conservative, documented upper bound on one sync batch (Engineering
 * Quality & Security Baseline Audit, spec section 10). A single realistic
 * offline session generates well under 100 commands (a handful of
 * exercises x sets x occasional reopen/recomplete, plus START/FINISH);
 * this leaves generous headroom for a genuinely long offline gap spanning
 * several sessions before the client next reaches the network, while still
 * bounding worst-case per-request DB work against a malformed/hostile
 * payload. A code-level constant, not an env var, matching this
 * codebase's existing tunable-constant convention (e.g. `SyncEngine`'s
 * `DEFAULT_BATCH_SIZE`) rather than introducing new runtime config for a
 * single limit.
 */
export const MAX_COMMANDS_PER_SYNC_BATCH = 500;

export class SyncWorkoutCommandsRequestDto {
  /** Auth & Local Athlete Boundary V1 Slice B — consistency guard only (see `SyncWorkoutCommandsRequest.ownerUserId`); never authorization. */
  @IsUUID()
  ownerUserId!: string;

  @ArrayMaxSize(MAX_COMMANDS_PER_SYNC_BATCH)
  @ValidateNested({ each: true })
  @Type(() => WorkoutCommandDto)
  commands!: WorkoutCommandDto[];
}
