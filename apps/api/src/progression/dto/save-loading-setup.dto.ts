import { ArrayMinSize, IsArray, IsIn, IsInt, Min, ValidateIf } from "class-validator";

/**
 * Progression Application V1 — Slice F (task §6/§13) — the configuration
 * payload only. No `userId`/`exerciseRef`/`gymProfileId`/
 * `loadingCapabilityId`/unit/basis/mode/application-status field exists
 * here (task §13's own explicit list) — unit/basis are always derived
 * server-side from the application's current effective load context.
 *
 * Structural validation only (types, non-empty, positive integers) — the
 * canonical semantic validation (`validateEnumeratedListLoads`: strictly
 * ascending, unique) is `@vostivo/domain`'s, applied again server-side
 * inside `saveGuidedLoadingSetup` before any persistence, never trusted
 * from this transport-layer shape alone.
 */
export class SaveLoadingSetupRequestDto {
  @IsIn(["FIXED_INCREMENT", "ENUMERATED_LIST"])
  kind!: "FIXED_INCREMENT" | "ENUMERATED_LIST";

  @ValidateIf((dto: SaveLoadingSetupRequestDto) => dto.kind === "FIXED_INCREMENT")
  @IsInt()
  @Min(1)
  incrementAmountMilli?: number;

  @ValidateIf((dto: SaveLoadingSetupRequestDto) => dto.kind === "ENUMERATED_LIST")
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  loadsMilli?: readonly number[];
}
