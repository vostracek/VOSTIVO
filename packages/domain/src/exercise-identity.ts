/**
 * The smallest explicit boundary needed to safely associate the same
 * real-world exercise across separate `WorkoutSession`s (Active Workout
 * Core Logger V1, section 8 — "Previous performance"). This is NOT a new
 * concept: it names and reuses the existing opaque catalog pointer
 * (`PlannedExercise.exerciseRef` / `PrescribedExerciseV1.exerciseRef`),
 * which was already present but previously unused for cross-session
 * matching.
 *
 * `null` means "no stable identity available for this exercise" — in that
 * case Previous performance must not be shown (never fuzzy-matched by
 * display name, never fabricated). This is deliberately NOT the full
 * Exercise Taxonomy (catalog metadata, muscle groups, equipment
 * relationships, etc.) — see docs/architecture/PLAN-PRESCRIPTION.md's
 * "Deliberate deferrals," which this narrow boundary does not resolve.
 */
export type ExerciseIdentityV1 = string;
