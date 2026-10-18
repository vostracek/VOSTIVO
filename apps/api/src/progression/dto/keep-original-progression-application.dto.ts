import { IsUUID } from "class-validator";

/** Progression Application V1 — Slice D (task §27) — `commandId` only; every other fact (ownership, mode, currentness) is server-derived. */
export class KeepOriginalProgressionApplicationRequestDto {
  @IsUUID(7)
  commandId!: string;
}
