import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { AvailableTimePreviewResponseV1, EquipmentAdaptationApplyResponseV1, EquipmentAdaptationOptionsResponseV1, EquipmentAdaptationPreviewResponseV1, MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1, PlanOverviewV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { PlanReadService } from "./plan-read.service.js";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";
import { AvailableTimePreviewRequestDto } from "./dto/available-time-preview.dto.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { MissedWorkoutPreviewRequestDto } from "./dto/missed-workout-preview.dto.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { MissedWorkoutApplyRequestDto } from "./dto/missed-workout-apply.dto.js";
import { EquipmentAdaptationPreviewService } from "./equipment-adaptation-preview.service.js";
import { EquipmentAdaptationPreviewRequestDto } from "./dto/equipment-adaptation-preview.dto.js";
import { EquipmentAdaptationApplyService } from "./equipment-adaptation-apply.service.js";
import { EquipmentAdaptationApplyRequestDto } from "./dto/equipment-adaptation-apply.dto.js";
import { EquipmentAdaptationOptionsService } from "./equipment-adaptation-options.service.js";
import { EquipmentAdaptationOptionsQueryDto } from "./dto/equipment-adaptation-options.dto.js";

/**
 * The smallest read API this slice needs (spec section 21) — no generic
 * Program CRUD endpoints, no arbitrary Program edit endpoints yet.
 */
@ApiTags("plan")
@ApiBearerAuth()
@Controller("plan")
@UseGuards(AuthGuard)
export class PlanController {
  constructor(
    private readonly planRead: PlanReadService,
    private readonly availableTimePreview: AvailableTimePreviewService,
    private readonly missedWorkoutPreview: MissedWorkoutPreviewService,
    private readonly missedWorkoutApply: MissedWorkoutApplyService,
    private readonly equipmentAdaptationPreview: EquipmentAdaptationPreviewService,
    private readonly equipmentAdaptationApply: EquipmentAdaptationApplyService,
    private readonly equipmentAdaptationOptions: EquipmentAdaptationOptionsService,
  ) {}

  @Get("current")
  @ApiOkResponse({ description: "The authenticated athlete's current Plan overview." })
  getCurrent(@CurrentActor() actor: AuthenticatedActor): Promise<PlanOverviewV1> {
    return this.planRead.getCurrentPlanOverview(actor);
  }

  @Get("workouts/:plannedWorkoutId")
  @ApiOkResponse({ description: "The Workout Preview for a planned workout owned by the authenticated athlete." })
  async getWorkoutPreview(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("plannedWorkoutId") plannedWorkoutId: string,
  ): Promise<WorkoutPreviewV1> {
    const preview = await this.planRead.getWorkoutPreview(actor, plannedWorkoutId);
    if (preview === undefined) {
      // Uniform "not found" whether the workout doesn't exist or belongs
      // to another athlete — no existence leakage (spec section 46).
      throw new NotFoundException("Planned workout not found");
    }
    return preview;
  }

  /**
   * Available-Time Adaptation V1 — Slice B: a read-only structural preview
   * (POST only because it takes a request body; it never mutates anything,
   * hence 200 rather than 201). Not found / not owned -> 404,
   * already started -> 409 WORKOUT_ALREADY_STARTED, invalid authored
   * structure -> 422 with a stable AVAILABLE_TIME_* code.
   */
  @Post("workouts/:plannedWorkoutId/available-time-preview")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "A read-only available-time/v1 preview of the authenticated athlete's planned workout." })
  previewAvailableTime(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("plannedWorkoutId", new ParseUUIDPipe()) plannedWorkoutId: string,
    @Body() request: AvailableTimePreviewRequestDto,
  ): Promise<AvailableTimePreviewResponseV1> {
    return this.availableTimePreview.preview(actor, plannedWorkoutId, request.availableMinutes);
  }

  /**
   * Missed Workout / Schedule Adaptation V1 — Slice B: a read-only
   * `missed-workout/v1` preview of the athlete's CURRENT schedule. The body
   * must be empty: the local date, training slots and workout ids are all
   * server-derived (any client field -> 400). Missing training time zone ->
   * 409 TRAINING_TIME_ZONE_REQUIRED; no single current block -> 409
   * CURRENT_TRAINING_BLOCK_UNRESOLVED; never a mutation, hence 200.
   */
  @Post("missed-workout-preview")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "A read-only missed-workout/v1 preview of the authenticated athlete's current training block." })
  previewMissedWorkout(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() _request: MissedWorkoutPreviewRequestDto,
  ): Promise<MissedWorkoutPreviewResponseV1> {
    return this.missedWorkoutPreview.preview(actor);
  }

  /**
   * Missed Workout / Schedule Adaptation V1 — Slice C: durably apply the
   * previewed ROLL_FORWARD as an effective schedule overlay. Only the
   * approved `previewFingerprint` is accepted (400 for anything else); the
   * server re-derives everything. 200 for a new application AND for an
   * idempotent retry of the same fingerprint. 409
   * MISSED_WORKOUT_PREVIEW_STALE / MISSED_WORKOUT_NOT_APPLICABLE (+
   * reasonCode) / TRAINING_TIME_ZONE_REQUIRED /
   * CURRENT_TRAINING_BLOCK_UNRESOLVED; 404 without an athlete profile.
   */
  @Post("missed-workout-apply")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Applies the authenticated athlete's previewed missed-workout ROLL_FORWARD as an effective schedule overlay." })
  applyMissedWorkout(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() request: MissedWorkoutApplyRequestDto,
  ): Promise<MissedWorkoutApplyResponseV1> {
    return this.missedWorkoutApply.apply(actor, request.previewFingerprint);
  }

  /**
   * Temporary Equipment / Gym Adaptation V1 — Slice B: a READ-ONLY
   * `equipment-adaptation/v1` preview of today's effective workout for the
   * COMPLETE session equipment inventory the athlete declares. 200, never a
   * mutation. 400 strict body / UNKNOWN_EQUIPMENT_ID; 404 not found / not
   * owned; 409 EQUIPMENT_CATALOG_VERSION_MISMATCH /
   * TRAINING_TIME_ZONE_REQUIRED / EQUIPMENT_ADAPTATION_NOT_APPLICABLE
   * (+reasonCode); 422 EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION.
   */
  @Post("equipment-adaptation-preview")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "A read-only equipment-adaptation/v1 preview of the authenticated athlete's workout for today." })
  previewEquipmentAdaptation(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() request: EquipmentAdaptationPreviewRequestDto,
  ): Promise<EquipmentAdaptationPreviewResponseV1> {
    return this.equipmentAdaptationPreview.preview(actor, request);
  }

  /**
   * Temporary Equipment / Gym Adaptation V1 — Slice D: READ-ONLY
   * decision-relevant equipment choices (canonical ids + labels) for
   * today's workout, plus today's still-applicable application's declared
   * inventory. Same applicability as the preview: 400 bad query; 404 not
   * found / not owned; 409 TRAINING_TIME_ZONE_REQUIRED /
   * EQUIPMENT_ADAPTATION_NOT_APPLICABLE (+reasonCode).
   */
  @Get("equipment-adaptation-options")
  @ApiOkResponse({ description: "Read-only equipment choices that can change today's workout adaptation." })
  equipmentAdaptationOptionsForWorkout(
    @CurrentActor() actor: AuthenticatedActor,
    @Query() query: EquipmentAdaptationOptionsQueryDto,
  ): Promise<EquipmentAdaptationOptionsResponseV1> {
    return this.equipmentAdaptationOptions.options(actor, query.plannedWorkoutId);
  }

  /**
   * Temporary Equipment / Gym Adaptation V1 — Slice C: durably apply the
   * approved preview as today's TODAY_ONLY equipment adaptation. The server
   * re-derives everything; 200 for a new application AND an idempotent
   * retry. 409 EQUIPMENT_PREVIEW_STALE / EQUIPMENT_ADAPTATION_REVIEW_REQUIRED
   * (+reasonCode) / EQUIPMENT_ADAPTATION_NOT_APPLICABLE (+reasonCode) /
   * EQUIPMENT_CATALOG_VERSION_MISMATCH / TRAINING_TIME_ZONE_REQUIRED; 400;
   * 404 not found / not owned.
   */
  @Post("equipment-adaptation-apply")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Applies the approved equipment-adaptation preview as today's TODAY_ONLY adaptation." })
  applyEquipmentAdaptation(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() request: EquipmentAdaptationApplyRequestDto,
  ): Promise<EquipmentAdaptationApplyResponseV1> {
    return this.equipmentAdaptationApply.apply(actor, request);
  }
}
