import { IsString, MaxLength } from "class-validator";

/**
 * Missed Workout / Schedule Adaptation V1 Slice B. Shape only — whether the
 * value is a real IANA zone (not an offset like "+02:00") is decided by
 * `normalizeTrainingTimeZone` in the service, the single validation rule.
 */
export class UpdateTrainingTimeZoneRequestDto {
  @IsString()
  @MaxLength(64)
  trainingTimeZone!: string;
}
