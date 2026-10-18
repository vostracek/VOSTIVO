import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  athleteProfiles,
  authIdentities,
  AUTH_PROVIDER_VALUES,
  EXPERIENCE_MODE_VALUES,
  UNIT_SYSTEM_VALUES,
  USER_STATUS_VALUES,
  users,
} from "./identity.js";

/**
 * Schema-shape tests only — no live Postgres connection required (spec
 * section 16). The actual migration was generated and applied to local
 * Postgres separately (see docs/architecture/IDENTITY-AUTH.md).
 */
describe("identity schema", () => {
  it("defines users, auth_identities, and athlete_profiles in the app schema", () => {
    expect(getTableName(users)).toBe("users");
    expect(getTableName(authIdentities)).toBe("auth_identities");
    expect(getTableName(athleteProfiles)).toBe("athlete_profiles");
  });

  it("does not persist COACHED as a base experience mode", () => {
    expect(EXPERIENCE_MODE_VALUES).toEqual(["GUIDED", "ADAPTIVE", "EXPERT"]);
  });

  it("locks the user status vocabulary", () => {
    expect(USER_STATUS_VALUES).toEqual(["ACTIVE", "DELETION_PENDING", "SUSPENDED", "DELETED"]);
  });

  it("locks the auth provider vocabulary to what is actually integrated", () => {
    expect(AUTH_PROVIDER_VALUES).toEqual(["supabase"]);
  });

  it("matches the Load Model V1 unit vocabulary", () => {
    expect(UNIT_SYSTEM_VALUES).toEqual(["METRIC", "IMPERIAL"]);
  });

  it("requires user_id on auth_identities and athlete_profiles", () => {
    expect(Object.keys(authIdentities)).toEqual(expect.arrayContaining(["userId"]));
    expect(Object.keys(athleteProfiles)).toEqual(expect.arrayContaining(["userId"]));
  });
});
