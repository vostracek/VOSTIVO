import { IsUUID } from "class-validator";

/** Temporary Equipment V1 Slice D — the target workout only; any other query parameter is a 400 (global `forbidNonWhitelisted`). */
export class EquipmentAdaptationOptionsQueryDto {
  @IsUUID("all")
  plannedWorkoutId!: string;
}
