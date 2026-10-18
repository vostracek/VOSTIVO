import type { ExperienceMode, UnitSystem, UserStatus } from "@vostivo/domain";

/**
 * Explicit response projection for `GET /api/v1/me` — never the raw DB
 * row (spec section 21: database table != API contract, a locked Vostivo
 * principle). Contains only safe Vostivo identity/profile information —
 * no provider internals, no database fields beyond these, no JWT, no
 * security metadata.
 */
export interface MeResponse {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly status: UserStatus;
  readonly experienceMode: ExperienceMode;
  readonly unitSystem: UnitSystem;
  /**
   * Missed Workout / Schedule Adaptation V1 Slice B — the athlete's IANA
   * training time zone, or `null` until it has been explicitly set (never a
   * silent UTC default). Additive.
   */
  readonly trainingTimeZone: string | null;
}

/** `PUT /api/v1/me/training-time-zone` — an IANA zone id (e.g. "Europe/Prague"); offsets like "+02:00" are rejected. */
export interface UpdateTrainingTimeZoneRequestV1 {
  readonly trainingTimeZone: string;
}
