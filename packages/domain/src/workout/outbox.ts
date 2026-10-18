/**
 * Domain-aware outbox vocabulary (spec section 18) — commands represent
 * domain intent, not "sync every table row." Deliberately kept to the
 * three commands this slice actually needs; a new command type is a
 * deliberate addition, not a generic mechanism.
 */
export const WORKOUT_COMMAND_TYPES = [
  "START_WORKOUT_SESSION_V1",
  "COMPLETE_SET_V1",
  "REOPEN_SET_V1",
  "FINISH_WORKOUT_SESSION_V1",
] as const;
export type WorkoutCommandType = (typeof WORKOUT_COMMAND_TYPES)[number];

export const OUTBOX_COMMAND_STATUSES = [
  "PENDING",
  "SYNCING",
  "SYNCED",
  "RETRY",
  "CONFLICT",
  "REJECTED",
] as const;
export type OutboxCommandStatus = (typeof OUTBOX_COMMAND_STATUSES)[number];
