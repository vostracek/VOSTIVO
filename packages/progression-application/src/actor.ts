/**
 * The minimal structural identity `WorkoutHistoryService`/
 * `ProgressionEvaluationService` need for ownership checks (`userId` only —
 * never `athleteProfileId`, see each service's own doc comment). Deliberately
 * NOT `apps/api`'s `AuthenticatedActor` — this package must stay callable
 * from a non-HTTP runtime (`apps/worker`) with no real authenticated
 * request in play. `AuthenticatedActor` is structurally assignable to this
 * type (it has a superset of fields), so `apps/api`'s existing call sites
 * pass an `AuthenticatedActor` here unchanged.
 */
export interface ProgressionActorV1 {
  readonly userId: string;
}
