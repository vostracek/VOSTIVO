import { IsString, Matches } from "class-validator";

/**
 * Missed Workout V1 Slice C: ONLY the fingerprint of the approved preview
 * (lowercase SHA-256 hex). With the global `forbidNonWhitelisted`
 * ValidationPipe any other field (dates, slots, ids, sequence, zone…) is
 * a 400 — every schedule input is re-derived server-side.
 */
export class MissedWorkoutApplyRequestDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  previewFingerprint!: string;
}
