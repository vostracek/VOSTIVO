import { IsIn, IsInt, Min } from "class-validator";
import { LOAD_BASES_V1, LOAD_UNITS, type LoadBasisV1, type LoadUnit } from "@vostivo/domain";

/**
 * Stage 1 Load Model subset only (docs/domain/load-model-v1.md section
 * 106) — EXTERNAL_WEIGHT / KG|LB / TOTAL|PER_IMPLEMENT. Structural
 * validation here (types, enum membership, non-negative integer); the
 * canonical semantic validation is `@vostivo/domain`'s
 * `validateExternalWeightLoad`, applied again server-side before any
 * persistence (never trust transport-layer validation alone).
 */
export class ExternalWeightLoadDto {
  @IsIn(["EXTERNAL_WEIGHT"])
  kind!: "EXTERNAL_WEIGHT";

  @IsInt()
  @Min(0)
  amountMilli!: number;

  @IsIn(LOAD_UNITS)
  unit!: LoadUnit;

  @IsIn(LOAD_BASES_V1)
  basis!: LoadBasisV1;
}
