/**
 * Internal API actor representation (spec section 18). Deliberately does
 * NOT include fabricated permissions (`isAdmin`, `isCoach`, `isPro`) —
 * those would have to be derived from real domain state that doesn't
 * exist yet. `athleteProfileId` is optional because `User` is general
 * account identity, not permanently athlete-only (spec section 31).
 */
export interface AuthenticatedActor {
  readonly userId: string;
  readonly athleteProfileId?: string;
}
