import { Type } from "class-transformer";
import { IsInt, IsUUID, Min, ValidateNested } from "class-validator";
import { ExternalWeightLoadDto } from "../../workout/dto/external-weight-load.dto.js";

/**
 * Progression Application V1 — Slice D (task §26) — `commandId` + the
 * full human proposal precondition (task §43: "ATHLETE: proposal
 * precondition REQUIRED"), enforced right here by making every field on
 * this DTO non-optional. No `userId`/mode/`exerciseRef`/capability
 * authority/`appliedLoad`/`status` field exists at all (task §26) — there
 * is nothing here for a client to spoof.
 */
export class ApplyProgressionApplicationRequestDto {
  @IsUUID(7)
  commandId!: string;

  @ValidateNested()
  @Type(() => ExternalWeightLoadDto)
  expectedCurrentEffectiveLoad!: ExternalWeightLoadDto;

  @IsUUID(7)
  expectedLoadingCapabilityId!: string;

  @IsInt()
  @Min(1)
  expectedLoadingCapabilityRevision!: number;

  @ValidateNested()
  @Type(() => ExternalWeightLoadDto)
  expectedResolverProposedLoad!: ExternalWeightLoadDto;
}
