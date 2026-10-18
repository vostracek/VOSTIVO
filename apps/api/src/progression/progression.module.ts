import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ProgressionController } from "./progression.controller.js";
import { ProgressionReviewService } from "./progression-review.service.js";
import { GuidedLoadingSetupController } from "./guided-loading-setup.controller.js";
import { GuidedLoadingSetupService } from "./guided-loading-setup.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ProgressionController, GuidedLoadingSetupController],
  providers: [ProgressionReviewService, GuidedLoadingSetupService],
})
export class ProgressionModule {}
