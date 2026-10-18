import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MeController } from "./me.controller.js";
import { MeProjectionService } from "./me-projection.service.js";

@Module({
  imports: [AuthModule],
  controllers: [MeController],
  providers: [MeProjectionService],
})
export class MeModule {}
