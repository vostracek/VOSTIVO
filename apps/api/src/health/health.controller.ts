import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service.js";
import type { LivenessResponse, ReadinessResponse } from "./health.types.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Process is up and able to handle requests." })
  liveness(): LivenessResponse {
    return this.healthService.checkLiveness();
  }

  @Get("ready")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Process is ready to serve traffic (dependencies OK)." })
  readiness(): ReadinessResponse {
    return this.healthService.checkReadiness();
  }
}
