import { Injectable } from "@nestjs/common";
import type { LivenessResponse, ReadinessResponse } from "./health.types.js";

@Injectable()
export class HealthService {
  /**
   * Liveness only proves the process itself is running — it must never
   * check downstream dependencies (DB, etc), or an unrelated outage takes
   * down the orchestrator's restart signal along with it.
   */
  checkLiveness(): LivenessResponse {
    return { status: "ok", uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness is intentionally still a bootstrap placeholder — no
   * dependency (DB, etc) checks exist yet in Foundation Bootstrap. The
   * first vertical slice that adds a real dependency must extend this to
   * check it before serving traffic.
   */
  checkReadiness(): ReadinessResponse {
    return { status: "ok" };
  }
}
