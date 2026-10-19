import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { ExerciseHistoryPageV1, ProgressOverviewV1, WorkoutHistoryDetailV1, WorkoutHistoryPageV1 } from "@vostivo/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentActor } from "../auth/current-actor.decorator.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { ProgressReadService } from "./progress-read.service.js";
import { ProgressPageQueryDto } from "./dto/progress-page-query.dto.js";

/**
 * Progress & Feedback V1 — Slice A: the four owner-scoped Progress reads
 * (docs/domain/PROGRESS-AND-FEEDBACK-V1.md §6). Read only. No `athleteId`
 * parameter anywhere — ownership comes from the authenticated actor;
 * unknown and foreign ids are the same 404. 400 for a malformed id,
 * `limit` or `before` cursor (INVALID_CURSOR).
 */
@ApiTags("progress")
@ApiBearerAuth()
@Controller("progress")
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(private readonly progressRead: ProgressReadService) {}

  @Get()
  @ApiOkResponse({ description: "The authenticated athlete's Progress overview: snapshot, applied improvements, recent workouts." })
  getOverview(@CurrentActor() actor: AuthenticatedActor): Promise<ProgressOverviewV1> {
    return this.progressRead.getOverview(actor);
  }

  @Get("workouts")
  @ApiOkResponse({ description: "A keyset page of the authenticated athlete's completed workouts, newest first." })
  getWorkoutHistory(@CurrentActor() actor: AuthenticatedActor, @Query() query: ProgressPageQueryDto): Promise<WorkoutHistoryPageV1> {
    return this.progressRead.getWorkoutHistory(actor, query);
  }

  @Get("workouts/:workoutSessionId")
  @ApiOkResponse({ description: "One completed workout of the authenticated athlete: exercises, sets, adaptations, applied progressions." })
  getWorkoutDetail(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("workoutSessionId", new ParseUUIDPipe()) workoutSessionId: string,
  ): Promise<WorkoutHistoryDetailV1> {
    return this.progressRead.getWorkoutDetail(actor, workoutSessionId);
  }

  @Get("exercises/:exerciseRef")
  @ApiOkResponse({ description: "A keyset page of the authenticated athlete's performances of one exercise identity, newest first." })
  getExerciseHistory(
    @CurrentActor() actor: AuthenticatedActor,
    @Param("exerciseRef") exerciseRef: string,
    @Query() query: ProgressPageQueryDto,
  ): Promise<ExerciseHistoryPageV1> {
    return this.progressRead.getExerciseHistory(actor, exerciseRef, query);
  }
}
