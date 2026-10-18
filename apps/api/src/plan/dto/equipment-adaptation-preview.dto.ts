import { ArrayMaxSize, IsArray, IsString, IsUUID, MaxLength } from "class-validator";

/**
 * Temporary Equipment V1 Slice B — STRICT: target identity, catalog version
 * and the COMPLETE session inventory only. With the global
 * `forbidNonWhitelisted` ValidationPipe any other field (substitutes,
 * replacements, tiers, priorities, names, locks, athlete id, date, time
 * zone…) is a 400. Catalog membership of each id is checked server-side
 * (400 UNKNOWN_EQUIPMENT_ID).
 */
export class EquipmentAdaptationPreviewRequestDto {
  @IsUUID("all")
  plannedWorkoutId!: string;

  @IsString()
  @MaxLength(64)
  catalogVersion!: string;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  availableEquipmentIds!: string[];
}
