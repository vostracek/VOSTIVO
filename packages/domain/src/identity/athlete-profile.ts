import type { EntityId } from "../entity-id.js";
import type { UserId } from "./user.js";
import type { TrainingTimeZone } from "../schedule/training-time-zone.js";

export type AthleteProfileId = EntityId<"AthleteProfile">;

/**
 * Persisted experience mode (locked correction, spec section 6):
 * `COACHED` is deliberately NOT a stored base mode. Coached experience is
 * derived later from an active CoachingRelationship, not stored as a
 * fourth mode here — adding it to this enum would let a mode value and an
 * actual coaching relationship disagree.
 */
export const EXPERIENCE_MODES = ["GUIDED", "ADAPTIVE", "EXPERT"] as const;
export type ExperienceMode = (typeof EXPERIENCE_MODES)[number];

/**
 * Matches the unit vocabulary already locked in the Load Model V1
 * specification (docs/domain/load-model-v1.md section 96) — this is a
 * display/default preference, never a mechanism that rewrites historical
 * equipment units (LOAD-INV-004).
 */
export const UNIT_SYSTEMS = ["METRIC", "IMPERIAL"] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/**
 * Deliberately minimal (spec section 7) — only fields this identity
 * foundation actually needs. birthDate/gender/bodyweight/health
 * history/location are NOT included; they belong to a future onboarding
 * slice, not this one.
 */
export interface AthleteProfile {
  readonly id: AthleteProfileId;
  readonly userId: UserId;
  readonly experienceMode: ExperienceMode;
  readonly unitSystem: UnitSystem;
  /** IANA training time zone — `null` until explicitly set (never a silent UTC default). */
  readonly trainingTimeZone: TrainingTimeZone | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
