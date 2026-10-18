export interface LivenessResponse {
  status: "ok";
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: "ok";
}
