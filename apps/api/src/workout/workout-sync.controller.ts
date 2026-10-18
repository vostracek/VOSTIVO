import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { SyncWorkoutCommandsRequestDto } from "./dto/workout-command.dto.js";
import { WorkoutSyncService } from "./workout-sync.service.js";

/**
 * Batches pending domain commands rather than one HTTP request per set
 * (spec section 26). Ownership always comes from `AuthenticatedActor` —
 * never from the request body (spec section 21/24).
 */
@ApiTags("workout-sync")
@ApiBearerAuth()
@Controller("sync/workout-commands")
@UseGuards(AuthGuard)
export class WorkoutSyncController {
  constructor(private readonly workoutSyncService: WorkoutSyncService) {}

  @Post()
  @ApiOkResponse({ description: "Per-command acknowledgements for a batch of workout sync commands." })
  syncCommands(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() request: SyncWorkoutCommandsRequestDto,
  ): Promise<SyncWorkoutCommandsResponse> {
    return this.workoutSyncService.syncCommands(actor.userId, request);
  }
}
