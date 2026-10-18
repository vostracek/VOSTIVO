/**
 * Planned Workout Occurrence Authority V1. For a session started from a
 * canonical PlannedWorkout, its role relative to that planned occurrence —
 * DERIVED from the server's occurrence claim, never stored on the session:
 *
 * - CANONICAL: the first valid server-accepted START claimed the occurrence;
 *   this is the one session that represents the planned occurrence for
 *   Plan/Today and planned progression semantics.
 * - SECONDARY: a later, distinct, valid START of the same occurrence (e.g. a
 *   second device offline). Still real, preserved workout history — it just
 *   never represents the planned occurrence.
 *
 * CANONICAL != "the only real workout". Unplanned sessions have no role.
 */
export const OCCURRENCE_SESSION_ROLES = ["CANONICAL", "SECONDARY"] as const;
export type OccurrenceSessionRole = (typeof OCCURRENCE_SESSION_ROLES)[number];
