import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { CLOCK, systemClock } from "../common/clock.js";
import { ProgressController } from "./progress.controller.js";
import { ProgressReadService } from "./progress-read.service.js";

/** Progress & Feedback V1 — Slice A. Reuses the stateless PlanReadService for the current-cycle snapshot (one schedule authority). */
@Module({
  imports: [AuthModule],
  controllers: [ProgressController],
  providers: [ProgressReadService, PlanReadService, { provide: CLOCK, useValue: systemClock }],
})
export class ProgressModule {}
