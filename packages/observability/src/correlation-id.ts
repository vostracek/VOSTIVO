import { randomUUID } from "node:crypto";

export const CORRELATION_ID_HEADER = "x-request-id";

export function createCorrelationId(): string {
  return randomUUID();
}
