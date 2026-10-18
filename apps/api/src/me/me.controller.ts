import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { MeResponse } from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { MeProjectionService } from "./me-projection.service.js";
import { UpdateTrainingTimeZoneRequestDto } from "./dto/update-training-time-zone.dto.js";

/**
 * Proves the full identity chain end to end (spec section 20): JWT ->
 * verification -> internal identity resolution -> safe projection.
 */
@ApiTags("me")
@ApiBearerAuth()
@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly meProjection: MeProjectionService) {}

  @Get()
  @ApiOkResponse({ description: "The authenticated actor's safe identity/profile projection." })
  getMe(@CurrentActor() actor: AuthenticatedActor): Promise<MeResponse> {
    return this.meProjection.getSafeProjection(actor);
  }

  /** Missed Workout / Schedule Adaptation V1 Slice B — explicit IANA training time zone (400 INVALID_TRAINING_TIME_ZONE otherwise). */
  @Put("training-time-zone")
  @ApiOkResponse({ description: "Sets the authenticated athlete's IANA training time zone and returns the updated projection." })
  setTrainingTimeZone(@CurrentActor() actor: AuthenticatedActor, @Body() request: UpdateTrainingTimeZoneRequestDto): Promise<MeResponse> {
    return this.meProjection.setTrainingTimeZone(actor, request.trainingTimeZone);
  }
}
