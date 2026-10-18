import type { EntityId } from "../entity-id.js";
import type { AthleteProfileId } from "../identity/athlete-profile.js";

export type ProgramId = EntityId<"Program">;

/**
 * `ARCHIVED` covers "athlete moved on / program retired" — there is no
 * delete operation in this slice (spec section 4: Program must not lose
 * reconstructability of what a `ProgramVersion` looked like historically).
 */
export const PROGRAM_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

/**
 * The long-lived logical training program an athlete is on. Deliberately
 * contains no performed-workout history (spec section 4) — that lives
 * entirely in the Workout Data Integrity slice's `WorkoutSession` /
 * `PerformedExercise` / `PerformedSet`, which this slice never mutates.
 *
 * Deliberately no `activeProgramVersionId` pointer here — "the active
 * version" is derived from `ProgramVersion.status === "ACTIVE"` (see
 * program-version.ts and the DB-enforced unique index in
 * packages/database/src/schema/plan.ts), not a denormalized field on
 * `Program`. This also avoids a circular type reference between `Program`
 * and `ProgramVersion`.
 */
export interface Program {
  readonly id: ProgramId;
  readonly athleteProfileId: AthleteProfileId;
  readonly name: string;
  readonly status: ProgramStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
