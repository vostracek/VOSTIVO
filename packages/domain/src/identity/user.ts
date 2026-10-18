import type { EntityId } from "../entity-id.js";

export type UserId = EntityId<"User">;

/**
 * `User` is general account identity — not "athlete." A coach or a future
 * account type is still a `User` first (spec section 31); role-specific
 * concepts (AthleteProfile, future CoachProfile) attach to a `User`, they
 * don't replace it.
 */
export const USER_STATUSES = ["ACTIVE", "DELETION_PENDING", "SUSPENDED", "DELETED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  readonly id: UserId;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Authentication success does not imply a usable account (spec section 17).
 * This is the enforcement boundary for account-status policy; it
 * deliberately does not implement deletion/suspension processing yet —
 * only `ACTIVE` may proceed today.
 */
export function isUsableAccountStatus(status: UserStatus): boolean {
  return status === "ACTIVE";
}
