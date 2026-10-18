import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { GuidedLoadingSetupAttentionResponseV1, LoadingSetupContextResponseV1, SaveLoadingSetupResultResponseV1 } from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { SaveLoadingSetupRequestDto } from "./dto/save-loading-setup.dto.js";
import { GuidedLoadingSetupService } from "./guided-loading-setup.service.js";

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1) — a deliberately SEPARATE
 * controller/route family from `ProgressionController` (task §0's own
 * hard product distinction: this is equipment configuration, never
 * Apply/Keep-Original review — never merged into that surface).
 */
@ApiTags("progression")
@ApiBearerAuth()
@Controller("progression/guided-loading-setup")
@UseGuards(AuthGuard)
export class GuidedLoadingSetupController {
  constructor(private readonly guidedLoadingSetup: GuidedLoadingSetupService) {}

  @Get("attention")
  @ApiOkResponse({ description: "The authenticated athlete's single Guided contextual loading-setup attention item, if any." })
  getAttention(@CurrentActor() actor: AuthenticatedActor): Promise<GuidedLoadingSetupAttentionResponseV1> {
    return this.guidedLoadingSetup.getAttention(actor);
  }

  @Get(":applicationId")
  @ApiOkResponse({ description: "Presentation-safe canonical context for one application's contextual loading setup." })
  getContext(@CurrentActor() actor: AuthenticatedActor, @Param("applicationId") applicationId: string): Promise<LoadingSetupContextResponseV1> {
    return this.guidedLoadingSetup.getContext(actor, applicationId);
  }

  @Post(":applicationId")
  @ApiOkResponse({ description: "Saves the loading configuration for one exact exercise and attempts the blocked SYSTEM progression retry." })
  save(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("applicationId") applicationId: string,
    @Body() request: SaveLoadingSetupRequestDto,
  ): Promise<SaveLoadingSetupResultResponseV1> {
    return this.guidedLoadingSetup.save(actor, applicationId, request);
  }
}
