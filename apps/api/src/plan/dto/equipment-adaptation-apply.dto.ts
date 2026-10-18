import { ArrayMaxSize, IsArray, IsString, IsUUID, Matches, MaxLength } from "class-validator";

/**
 * Temporary Equipment V1 Slice C — STRICT: the target, the approved
 * preview's fingerprint, the catalog version and the SAME complete session
 * inventory the preview was evaluated with (the athlete's declared input —
 * the server keeps no preview store; the fingerprint binds it). Every other
 * field (replacements, substitutes, names, sets, loads, locks, blocks,
 * date, time zone, athlete) is a 400.
 */
export class EquipmentAdaptationApplyRequestDto {
  @IsUUID("all")
  plannedWorkoutId!: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  previewFingerprint!: string;

  @IsString()
  @MaxLength(64)
  catalogVersion!: string;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  availableEquipmentIds!: string[];
}
