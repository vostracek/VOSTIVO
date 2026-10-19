import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export const DEFAULT_PROGRESS_PAGE_LIMIT = 20;
export const MAX_PROGRESS_PAGE_LIMIT = 50;

/** Progress & Feedback V1 Slice A — keyset paging only; any other query parameter is a 400 (global `forbidNonWhitelisted`). */
export class ProgressPageQueryDto {
  /** The previous page's `nextCursor`. Validated as a cursor by the service (400 INVALID_CURSOR). */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PROGRESS_PAGE_LIMIT)
  limit?: number;
}
