import type { EntityId } from "../entity-id.js";
import type { ProgramId } from "./program.js";

export type ProgramVersionId = EntityId<"ProgramVersion">;

/**
 * `DRAFT` -> `ACTIVE` -> `SUPERSEDED` is a one-way progression. This slice
 * implements activation semantics only — no version-editing UX (spec
 * section 5). `SUPERSEDED` versions are retained forever, never deleted:
 * they are what makes historical reconstruction possible (spec section
 * 17) if the athlete asks "what was I doing 3 months ago."
 */
export const PROGRAM_VERSION_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED"] as const;
export type ProgramVersionStatus = (typeof PROGRAM_VERSION_STATUSES)[number];

/**
 * An effectively immutable structural version of a `Program`'s training
 * plan (spec section 5). Once `status` moves to `ACTIVE` (and forever
 * after, including once `SUPERSEDED`), its `TrainingBlock`/`TrainingCycle`/
 * `PlannedWorkout` structure must not be mutated in place — a future
 * structural change creates a new `ProgramVersion` with an incremented
 * `versionNumber`, it never rewrites this one. This slice does not
 * implement that "create a new version" operation; it only implements the
 * data model and the invariant.
 */
export interface ProgramVersion {
  readonly id: ProgramVersionId;
  readonly programId: ProgramId;
  readonly versionNumber: number;
  readonly status: ProgramVersionStatus;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
