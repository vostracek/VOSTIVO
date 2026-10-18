import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PlanController } from "./plan.controller.js";
import { PlanReadService } from "./plan-read.service.js";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { EquipmentAdaptationPreviewService } from "./equipment-adaptation-preview.service.js";
import { EquipmentAdaptationApplyService } from "./equipment-adaptation-apply.service.js";
import { EquipmentAdaptationOptionsService } from "./equipment-adaptation-options.service.js";
import { CLOCK, systemClock } from "../common/clock.js";

@Module({
  imports: [AuthModule],
  controllers: [PlanController],
  providers: [PlanReadService, AvailableTimePreviewService, MissedWorkoutPreviewService, MissedWorkoutApplyService, EquipmentAdaptationPreviewService, EquipmentAdaptationApplyService, EquipmentAdaptationOptionsService, { provide: CLOCK, useValue: systemClock }],
})
export class PlanModule {}
