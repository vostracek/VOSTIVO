import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type {
  PendingProgressionApplicationsResponseV1,
  ProgressionApplicationCommandResponseV1,
  ProgressionApplicationProposalResponseV1,
} from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { ApplyProgressionApplicationRequestDto } from "./dto/apply-progression-application.dto.js";
import { KeepOriginalProgressionApplicationRequestDto } from "./dto/keep-original-progression-application.dto.js";
import { ProgressionReviewService } from "./progression-review.service.js";

/**
 * Progression Application V1 — Slice D (task §23) — the minimal
 * authenticated athlete API. No UI, no generic recommendation endpoints
 * (task §23) — exactly the four routes this slice requires.
 */
@ApiTags("progression")
@ApiBearerAuth()
@Controller("progression/applications")
@UseGuards(AuthGuard)
export class ProgressionController {
  constructor(private readonly progressionReview: ProgressionReviewService) {}

  @Get("pending")
  @ApiOkResponse({ description: "The authenticated athlete's actionable pending progression review items." })
  getPending(@CurrentActor() actor: AuthenticatedActor): Promise<PendingProgressionApplicationsResponseV1> {
    return this.progressionReview.getPending(actor);
  }

  @Get(":applicationId/proposal")
  @ApiOkResponse({ description: "The live numeric proposal for one pending progression application, or why it is unavailable." })
  getProposal(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("applicationId") applicationId: string,
  ): Promise<ProgressionApplicationProposalResponseV1> {
    return this.progressionReview.getProposal(actor, applicationId);
  }

  @Post(":applicationId/apply")
  @ApiOkResponse({ description: "The durable outcome of confirming Apply for one progression application." })
  apply(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("applicationId") applicationId: string,
    @Body() request: ApplyProgressionApplicationRequestDto,
  ): Promise<ProgressionApplicationCommandResponseV1> {
    return this.progressionReview.apply(actor, applicationId, request);
  }

  @Post(":applicationId/keep-original")
  @ApiOkResponse({ description: "The durable outcome of explicitly keeping the original prescription for one progression application." })
  keepOriginal(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("applicationId") applicationId: string,
    @Body() request: KeepOriginalProgressionApplicationRequestDto,
  ): Promise<ProgressionApplicationCommandResponseV1> {
    return this.progressionReview.keepOriginal(actor, applicationId, request);
  }
}
