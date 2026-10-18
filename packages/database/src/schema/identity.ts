import { pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * Dedicated `app` schema for Vostivo application tables — kept separate
 * from `public` so Supabase-managed/other tooling schemas never collide
 * with domain tables, and so the schema boundary is visible in `psql`.
 */
export const appSchema = pgSchema("app");

export const USER_STATUS_VALUES = ["ACTIVE", "DELETION_PENDING", "SUSPENDED", "DELETED"] as const;
export const userStatusEnum = appSchema.enum("user_status", USER_STATUS_VALUES);

/**
 * General account identity — not "athlete." Role-specific data
 * (AthleteProfile today, a future CoachProfile) attaches to a `User`, it
 * never replaces it (spec section 31).
 */
export const users = appSchema.table("users", {
  id: uuid("id").primaryKey(),
  status: userStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const AUTH_PROVIDER_VALUES = ["supabase"] as const;
export const authProviderEnum = appSchema.enum("auth_provider", AUTH_PROVIDER_VALUES);

/**
 * External auth identity, separate from `User` (spec section 5). No
 * `ON DELETE CASCADE` — deleting a user's auth identity is a deliberate
 * account-lifecycle operation this foundation does not implement yet
 * (spec section 10), not an accidental side effect of a row delete
 * elsewhere.
 */
export const authIdentities = appSchema.table(
  "auth_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: authProviderEnum("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_identities_provider_provider_subject_unique").on(
      table.provider,
      table.providerSubject,
    ),
  ],
);

export const EXPERIENCE_MODE_VALUES = ["GUIDED", "ADAPTIVE", "EXPERT"] as const;
export const experienceModeEnum = appSchema.enum("experience_mode", EXPERIENCE_MODE_VALUES);

export const UNIT_SYSTEM_VALUES = ["METRIC", "IMPERIAL"] as const;
export const unitSystemEnum = appSchema.enum("unit_system", UNIT_SYSTEM_VALUES);

/**
 * Minimal identity/profile foundation only (spec section 7) — no
 * birthDate/gender/bodyweight/health-history/location. `userId` is unique:
 * exactly one AthleteProfile per User in this foundation.
 */
export const athleteProfiles = appSchema.table(
  "athlete_profiles",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    experienceMode: experienceModeEnum("experience_mode").notNull(),
    unitSystem: unitSystemEnum("unit_system").notNull(),
    /**
     * Missed Workout / Schedule Adaptation V1 — Slice B: the IANA time zone
     * the athlete's planned-workout calendar is interpreted in (never a
     * locale, offset or server zone; validated by `normalizeTrainingTimeZone`
     * in @vostivo/domain before any write). Nullable WITHOUT a default on
     * purpose: existing athletes were never asked, and backfilling UTC would
     * silently change their calendar semantics. Calendar-aware features fail
     * closed (TRAINING_TIME_ZONE_REQUIRED) while it is NULL; it is set
     * explicitly and never overwritten automatically.
     */
    trainingTimeZone: text("training_time_zone"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("athlete_profiles_user_id_unique").on(table.userId)],
);
