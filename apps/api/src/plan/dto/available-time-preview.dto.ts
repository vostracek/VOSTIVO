import { IsInt, Max, Min } from "class-validator";

/**
 * Available-Time Adaptation V1 — Slice B §7. Whole minutes only: the
 * global `ValidationPipe` runs without implicit conversion, so a float, a
 * numeric string or a missing value is a 400, never rounded or coerced.
 * There is deliberately no `athleteId`/`userId` field — identity comes
 * from the authenticated actor, and `forbidNonWhitelisted` rejects any
 * extra field outright.
 */
export class AvailableTimePreviewRequestDto {
  @IsInt()
  @Min(1)
  @Max(240)
  availableMinutes!: number;
}
