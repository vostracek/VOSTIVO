import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  authIdentities,
  createDatabaseClient,
  users,
  type Database,
} from "@vostivo/database";
import { resolveOrCreateIdentity } from "./identity-resolution.js";

/**
 * Real Postgres integration tests — require a local database
 * (DATABASE_URL, defaults to the repo's docker-compose Postgres). Never a
 * real Supabase project (spec section 25). Run via `pnpm test:integration`,
 * not part of the default `pnpm test` gate (spec section 16: core unit
 * tests must not require a live DB connection).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

const TEST_SUBJECT_PREFIX = "identity-resolution-test-";

function testSubject(name: string): string {
  return `${TEST_SUBJECT_PREFIX}${name}`;
}

describe("resolveOrCreateIdentity (real Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  afterAll(async () => {
    await cleanupTestRows(db);
  });

  beforeEach(async () => {
    await cleanupTestRows(db);
  });

  it("ID-001: a valid verified subject creates exactly one User, AuthIdentity, and AthleteProfile", async () => {
    const subject = testSubject("id-001");

    const resolved = await resolveOrCreateIdentity(db, "supabase", subject);

    const userRows = await db.select().from(users).where(eq(users.id, resolved.userId));
    const identityRows = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, subject));

    expect(userRows).toHaveLength(1);
    expect(identityRows).toHaveLength(1);
    expect(resolved.athleteProfileId).toBeTruthy();
    expect(resolved.experienceMode).toBe("GUIDED");
    expect(resolved.unitSystem).toBe("METRIC");
  });

  it("ID-002: repeated resolution for the same subject returns the same internal IDs, no duplicates", async () => {
    const subject = testSubject("id-002");

    const first = await resolveOrCreateIdentity(db, "supabase", subject);
    const second = await resolveOrCreateIdentity(db, "supabase", subject);
    const third = await resolveOrCreateIdentity(db, "supabase", subject);

    expect(second.userId).toBe(first.userId);
    expect(second.athleteProfileId).toBe(first.athleteProfileId);
    expect(third.userId).toBe(first.userId);

    const identityRows = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, subject));
    expect(identityRows).toHaveLength(1);
  });

  it("ID-003: two different external subjects create two separate Vostivo users", async () => {
    const subjectA = testSubject("id-003-a");
    const subjectB = testSubject("id-003-b");

    const resolvedA = await resolveOrCreateIdentity(db, "supabase", subjectA);
    const resolvedB = await resolveOrCreateIdentity(db, "supabase", subjectB);

    expect(resolvedA.userId).not.toBe(resolvedB.userId);
    expect(resolvedA.athleteProfileId).not.toBe(resolvedB.athleteProfileId);
  });

  it("ID-004: identity uniqueness is enforced at the DB level, not just in application logic", async () => {
    const subject = testSubject("id-004");
    const resolved = await resolveOrCreateIdentity(db, "supabase", subject);

    // Bypass the resolver entirely and attempt a raw duplicate insert —
    // proves the UNIQUE(provider, provider_subject) constraint itself is
    // the safety net, not just resolveOrCreateIdentity's own find-first-check.
    await expect(
      db.insert(authIdentities).values({
        id: crypto.randomUUID(),
        userId: resolved.userId,
        provider: "supabase",
        providerSubject: subject,
      }),
    ).rejects.toThrow();
  });

  it("spec section 16: two concurrent first-time resolutions for the same subject produce exactly one User/AuthIdentity/AthleteProfile", async () => {
    const subject = testSubject("concurrency");

    const [resultA, resultB] = await Promise.all([
      resolveOrCreateIdentity(db, "supabase", subject),
      resolveOrCreateIdentity(db, "supabase", subject),
    ]);

    expect(resultA.userId).toBe(resultB.userId);
    expect(resultA.athleteProfileId).toBe(resultB.athleteProfileId);

    const identityRows = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, subject));
    const userRows = await db.select().from(users).where(eq(users.id, resultA.userId));

    expect(identityRows).toHaveLength(1);
    expect(userRows).toHaveLength(1);
  });
});

async function cleanupTestRows(db: Database): Promise<void> {
  const testIdentities = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(inArray(authIdentities.providerSubject, allKnownTestSubjects()));

  const userIds = testIdentities.map((row) => row.userId);
  if (userIds.length === 0) return;

  await db.delete(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
  await db.delete(authIdentities).where(inArray(authIdentities.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}

function allKnownTestSubjects(): string[] {
  return ["id-001", "id-002", "id-003-a", "id-003-b", "id-004", "concurrency"].map(testSubject);
}
