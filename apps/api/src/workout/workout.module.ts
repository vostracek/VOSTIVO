import { Module } from "@nestjs/common";
import { ProgressionEvaluationService, WorkoutHistoryService } from "@vostivo/progression-application";
import type { Database } from "@vostivo/database";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE } from "../database/database.module.js";
import { WorkoutSyncController } from "./workout-sync.controller.js";
import { WorkoutSyncService } from "./workout-sync.service.js";

/**
 * `WorkoutHistoryService`/`ProgressionEvaluationService` have no
 * controller — Progression Prerequisites V1 and Progression EngineDecision
 * Persistence & Evidence Integration V1 both deliberately avoid a
 * progression HTTP endpoint (see each service's own doc comment; no
 * approved real requirement for one has emerged). Exported so a future
 * orchestration/application-layer slice can inject either without this
 * module changing.
 *
 * Both classes live in `@vostivo/progression-application` (Progression
 * Evaluation Orchestration V1's shared-runtime extraction) as plain,
 * framework-agnostic classes with explicit constructor dependencies — no
 * Nest decorators, no `reflect-metadata` requirement (framework-boundary
 * cleanup). `apps/worker` constructs them directly with `new`. THIS module
 * is the one place that adapts them into Nest's DI container, via an
 * explicit `useFactory` provider per class — Nest can't auto-resolve an
 * undecorated class's constructor params from type reflection the way it
 * would for an `@Injectable()` class, so each dependency is wired by hand
 * here instead.
 */
@Module({
  imports: [AuthModule],
  controllers: [WorkoutSyncController],
  providers: [
    WorkoutSyncService,
    {
      provide: WorkoutHistoryService,
      useFactory: (db: Database): WorkoutHistoryService => new WorkoutHistoryService(db),
      inject: [DATABASE],
    },
    {
      provide: ProgressionEvaluationService,
      useFactory: (db: Database, historyService: WorkoutHistoryService): ProgressionEvaluationService =>
        new ProgressionEvaluationService(db, historyService),
      inject: [DATABASE, WorkoutHistoryService],
    },
  ],
  exports: [WorkoutHistoryService, ProgressionEvaluationService],
})
export class WorkoutModule {}
