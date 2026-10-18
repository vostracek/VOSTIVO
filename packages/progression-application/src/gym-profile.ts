import { and, eq } from "drizzle-orm";
import { gymProfiles, type Database } from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";

/**
 * Loading Capability V1 (`docs/domain/LOADING-CAPABILITY-V1.md` §16) —
 * V1's exactly-one-default-per-athlete `GymProfile`. Framework-agnostic
 * (no Nest, no HTTP) — callable from `apps/api` or `apps/worker` directly,
 * same convention as this package's other primitives.
 */
export interface GymProfileRecord {
  readonly id: string;
  readonly athleteProfileId: string;
  readonly isDefault: boolean;
}

/**
 * Idempotently resolves-or-creates the athlete's one default `GymProfile`
 * (spec §16: lazily, on first real capability configuration — never
 * merely because a user authenticated; this function's own caller decides
 * *when* to invoke it, this function only guarantees the *outcome* is
 * idempotent and race-safe once invoked).
 *
 * `athleteProfileId` is trusted as already server-verified by the
 * caller — this function never re-derives ownership itself (no
 * `userId`/actor parameter exists here to derive it from). The BOLA
 * contract lives at the composition boundary: nothing in this package
 * ever accepts a client-supplied `gymProfileId` directly — every real
 * caller must obtain one through this function, keyed by a canonical,
 * server-resolved `athleteProfileId`, so an actor can only ever reach
 * their OWN gym profile (see `loading-capability-lookup.ts`'s own doc
 * comment for the full composed BOLA argument).
 *
 * Concurrency-safe: two simultaneous first-calls for the same athlete
 * both attempt the insert; the real DB partial unique index
 * (`gym_profiles_one_default_per_athlete`) is the final race guard — the
 * loser's `onConflictDoNothing` returns no row, so it falls through to
 * re-select the winner's row. Never two default gym profiles for one
 * athlete, regardless of race timing.
 */
export async function getOrCreateDefaultGymProfileForAthlete(
  db: Database,
  athleteProfileId: string,
): Promise<GymProfileRecord> {
  const inserted = await db
    .insert(gymProfiles)
    .values({ id: createEntityId<"GymProfile">(), athleteProfileId, isDefault: true })
    .onConflictDoNothing({ target: gymProfiles.athleteProfileId, where: eq(gymProfiles.isDefault, true) })
    .returning({ id: gymProfiles.id, athleteProfileId: gymProfiles.athleteProfileId, isDefault: gymProfiles.isDefault });

  const [createdRow] = inserted;
  if (createdRow !== undefined) {
    return createdRow;
  }

  // Lost the race (or a default already existed from an earlier call) —
  // the winner's row is the real default; read it back.
  const [existingRow] = await db
    .select({ id: gymProfiles.id, athleteProfileId: gymProfiles.athleteProfileId, isDefault: gymProfiles.isDefault })
    .from(gymProfiles)
    .where(and(eq(gymProfiles.athleteProfileId, athleteProfileId), eq(gymProfiles.isDefault, true)))
    .limit(1);

  if (existingRow === undefined) {
    // Vanishingly unlikely (the row we just lost the insert race for
    // should always be readable immediately after), but never silently
    // return a fabricated profile if it somehow happens.
    throw new Error(
      `getOrCreateDefaultGymProfileForAthlete: conflict occurred but no default GymProfile row was found for athleteProfileId=${athleteProfileId}`,
    );
  }

  return existingRow;
}

/**
 * Progression Application V1 — Slice C (task §25): a **read-only** lookup,
 * never creating a `GymProfile` as a side effect. Numeric Apply must fail
 * with `LOADING_CAPABILITY_UNAVAILABLE` when no default `GymProfile` has
 * ever been configured — configuration creation belongs to profile/
 * capability setup, never to the Apply transaction itself. Deliberately a
 * separate function from `getOrCreateDefaultGymProfileForAthlete` rather
 * than a parameter flag, so every call site's intent (create-if-missing
 * vs. read-only) is visible at the call site, not buried in an argument.
 */
export async function findDefaultGymProfileForAthlete(
  db: Database,
  athleteProfileId: string,
): Promise<GymProfileRecord | null> {
  const [row] = await db
    .select({ id: gymProfiles.id, athleteProfileId: gymProfiles.athleteProfileId, isDefault: gymProfiles.isDefault })
    .from(gymProfiles)
    .where(and(eq(gymProfiles.athleteProfileId, athleteProfileId), eq(gymProfiles.isDefault, true)))
    .limit(1);
  return row ?? null;
}
