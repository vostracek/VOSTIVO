import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { athleteProfiles, authIdentities, users, type Database } from "@vostivo/database";
import {
  createEntityId,
  type AuthProvider,
  type ExperienceMode,
  type UnitSystem,
  type UserStatus,
} from "@vostivo/domain";

export interface ResolvedIdentity {
  readonly userId: string;
  readonly userStatus: UserStatus;
  readonly athleteProfileId: string;
  readonly experienceMode: ExperienceMode;
  readonly unitSystem: UnitSystem;
}

// Sensible, minimal defaults for a brand-new athlete profile. Onboarding
// (letting the athlete choose these) is a later, separate slice.
const DEFAULT_EXPERIENCE_MODE: ExperienceMode = "GUIDED";
const DEFAULT_UNIT_SYSTEM: UnitSystem = "METRIC";

const AUTH_IDENTITY_UNIQUE_CONSTRAINT = "auth_identities_provider_provider_subject_unique";

/**
 * Deterministic, idempotent identity resolution (spec section 15): finds
 * the User+AthleteProfile for an already-verified external identity, or
 * creates them together. A repeated call for the same external subject
 * never creates a duplicate Vostivo user.
 *
 * Concurrency (spec section 16): two simultaneous first-time calls for the
 * same external subject both attempt the create path; the database's
 * `UNIQUE(provider, provider_subject)` constraint lets exactly one
 * transaction commit, and the other catches the resulting unique-violation
 * and falls back to re-reading what its competitor just created — never a
 * bare "SELECT then INSERT" race.
 */
export async function resolveOrCreateIdentity(
  db: Database,
  provider: AuthProvider,
  providerSubject: string,
): Promise<ResolvedIdentity> {
  const existing = await findResolvedIdentity(db, provider, providerSubject);
  if (existing !== undefined) return existing;

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ id: createEntityId() }).returning();
      if (user === undefined) throw new Error("Failed to insert new user");

      await tx.insert(authIdentities).values({
        id: createEntityId(),
        userId: user.id,
        provider,
        providerSubject,
      });

      const [profile] = await tx
        .insert(athleteProfiles)
        .values({
          id: createEntityId(),
          userId: user.id,
          experienceMode: DEFAULT_EXPERIENCE_MODE,
          unitSystem: DEFAULT_UNIT_SYSTEM,
        })
        .returning();
      if (profile === undefined) throw new Error("Failed to insert new athlete profile");

      return {
        userId: user.id,
        userStatus: user.status,
        athleteProfileId: profile.id,
        experienceMode: profile.experienceMode,
        unitSystem: profile.unitSystem,
      };
    });
  } catch (error) {
    if (isAuthIdentityUniqueViolation(error)) {
      const afterRace = await findResolvedIdentity(db, provider, providerSubject);
      if (afterRace !== undefined) return afterRace;
    }
    throw error;
  }
}

async function findResolvedIdentity(
  db: Database,
  provider: AuthProvider,
  providerSubject: string,
): Promise<ResolvedIdentity | undefined> {
  const [row] = await db
    .select({
      userId: users.id,
      userStatus: users.status,
      athleteProfileId: athleteProfiles.id,
      experienceMode: athleteProfiles.experienceMode,
      unitSystem: athleteProfiles.unitSystem,
    })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .innerJoin(athleteProfiles, eq(athleteProfiles.userId, users.id))
    .where(
      and(
        eq(authIdentities.provider, provider),
        eq(authIdentities.providerSubject, providerSubject),
      ),
    )
    .limit(1);

  return row;
}

function isAuthIdentityUniqueViolation(error: unknown): boolean {
  return (
    error instanceof postgres.PostgresError &&
    error.code === "23505" &&
    error.constraint_name === AUTH_IDENTITY_UNIQUE_CONSTRAINT
  );
}
