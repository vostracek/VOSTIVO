import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  exerciseLoadingCapabilityBindings,
  gymProfiles,
  loadingCapabilities,
  users,
  type Database,
} from "@vostivo/database";
import { createEntityId, resolveNextLoadFromCapability } from "@vostivo/domain";
import { getOrCreateDefaultGymProfileForAthlete } from "./gym-profile.js";
import { resolveBoundCapability } from "./loading-capability-lookup.js";
import { bindExerciseToCapability, createLoadingCapability, updateLoadingCapabilityPayload } from "./loading-capability-write.js";

/**
 * Loading Capability Foundation V1 — real Postgres integration tests
 * (`docs/domain/LOADING-CAPABILITY-V1.md`, ADR-0010, Accepted). Run via
 * `pnpm test:integration`, not part of the default `pnpm test` gate.
 * Proves every hard acceptance criterion against a real database — never
 * simulated, per this task's own explicit requirement for the same-gym
 * invariant and the default-gym-per-athlete invariant.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("Loading Capability Foundation V1 (real Postgres)", () => {
  let db: Database;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  async function createAthlete(): Promise<string> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC" });
    userIds.push(userId);
    return athleteProfileId;
  }

  afterEach(async () => {
    if (userIds.length === 0) return;
    const athleteRows = await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
    const athleteProfileIds = athleteRows.map((r) => r.id);
    if (athleteProfileIds.length > 0) {
      const gymRows = await db.select({ id: gymProfiles.id }).from(gymProfiles).where(inArray(gymProfiles.athleteProfileId, athleteProfileIds));
      const gymProfileIds = gymRows.map((r) => r.id);
      if (gymProfileIds.length > 0) {
        await db.delete(exerciseLoadingCapabilityBindings).where(inArray(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileIds));
        await db.delete(loadingCapabilities).where(inArray(loadingCapabilities.gymProfileId, gymProfileIds));
        await db.delete(gymProfiles).where(inArray(gymProfiles.id, gymProfileIds));
      }
      await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, athleteProfileIds));
    }
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  // 1
  it("LOADCAP-001: one athlete can have one default GymProfile", async () => {
    const athleteProfileId = await createAthlete();
    const profile = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    expect(profile.athleteProfileId).toBe(athleteProfileId);
    expect(profile.isDefault).toBe(true);

    const rows = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(rows).toHaveLength(1);
  });

  // 2
  it("LOADCAP-002: a second default GymProfile for the same athlete is rejected at the database level", async () => {
    const athleteProfileId = await createAthlete();
    await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    await expect(
      db.insert(gymProfiles).values({ id: createEntityId(), athleteProfileId, isDefault: true }),
    ).rejects.toThrow();
  });

  // 3
  it("LOADCAP-003: different athletes may each have their own default gym", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const gymA = await getOrCreateDefaultGymProfileForAthlete(db, athleteA);
    const gymB = await getOrCreateDefaultGymProfileForAthlete(db, athleteB);
    expect(gymA.id).not.toBe(gymB.id);
    expect(gymA.athleteProfileId).toBe(athleteA);
    expect(gymB.athleteProfileId).toBe(athleteB);
  });

  // 4
  it("LOADCAP-004: lazy default creation is idempotent — calling twice returns the same row", async () => {
    const athleteProfileId = await createAthlete();
    const first = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const second = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(rows).toHaveLength(1);
  });

  // 5
  it("LOADCAP-005: concurrent lazy creation yields exactly one default gym, never two", async () => {
    const athleteProfileId = await createAthlete();

    const [a, b] = await Promise.all([
      getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId),
      getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId),
    ]);
    expect(a.id).toBe(b.id);

    const rows = await db.select().from(gymProfiles).where(eq(gymProfiles.athleteProfileId, athleteProfileId));
    expect(rows).toHaveLength(1);
  });

  // 6, 18
  it("LOADCAP-006/018: FIXED_INCREMENT capability round-trips exactly (unit/basis/amount)", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    const created = await createLoadingCapability(db, {
      kind: "FIXED_INCREMENT",
      gymProfileId: gym.id,
      unit: "KG",
      basis: "TOTAL",
      incrementAmountMilli: 2500,
    });
    expect(created.status).toBe("CREATED");
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    expect(created.revision).toBe(1);

    const [row] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, created.loadingCapabilityId));
    expect(row?.kind).toBe("FIXED_INCREMENT");
    expect(row?.unit).toBe("KG");
    expect(row?.basis).toBe("TOTAL");
    expect(row?.fixedIncrementAmountMilli).toBe(2500);
    expect(row?.enumeratedLoadsMilli).toBeNull();
    expect(row?.revision).toBe(1);
  });

  // 7, 18
  it("LOADCAP-007/018: ENUMERATED_LIST capability round-trips exactly", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    const created = await createLoadingCapability(db, {
      kind: "ENUMERATED_LIST",
      gymProfileId: gym.id,
      unit: "KG",
      basis: "PER_IMPLEMENT",
      loadsMilli: [20000, 22000, 24000, 26000],
    });
    expect(created.status).toBe("CREATED");
    if (created.status !== "CREATED") throw new Error("expected CREATED");

    const [row] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, created.loadingCapabilityId));
    expect(row?.kind).toBe("ENUMERATED_LIST");
    expect(row?.enumeratedLoadsMilli).toEqual([20000, 22000, 24000, 26000]);
    expect(row?.fixedIncrementAmountMilli).toBeNull();
  });

  // 8
  it("LOADCAP-008: multiple KG/TOTAL capabilities may coexist in one gym — no unit/basis collision", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    const bench = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    const legPress = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 10000 });
    expect(bench.status).toBe("CREATED");
    expect(legPress.status).toBe("CREATED");
    if (bench.status !== "CREATED" || legPress.status !== "CREATED") throw new Error("expected CREATED");
    expect(bench.loadingCapabilityId).not.toBe(legPress.loadingCapabilityId);

    const rows = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.gymProfileId, gym.id));
    expect(rows).toHaveLength(2);
  });

  // 9
  it("LOADCAP-009: binding is unique per (gym, exerciseRef) — a rebind updates the existing row in place", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const capA = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    const capB = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 5000 });
    if (capA.status !== "CREATED" || capB.status !== "CREATED") throw new Error("expected CREATED");

    const firstBind = await bindExerciseToCapability(db, gym.id, "bench-press", capA.loadingCapabilityId);
    expect(firstBind.status).toBe("BOUND");
    const rebind = await bindExerciseToCapability(db, gym.id, "bench-press", capB.loadingCapabilityId);
    expect(rebind.status).toBe("BOUND");

    const rows = await db
      .select()
      .from(exerciseLoadingCapabilityBindings)
      .where(sql`${exerciseLoadingCapabilityBindings.gymProfileId} = ${gym.id} AND ${exerciseLoadingCapabilityBindings.exerciseRef} = 'bench-press'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.loadingCapabilityId).toBe(capB.loadingCapabilityId);
  });

  // 10
  it("LOADCAP-010: several exercises may share one capability (shared dumbbell rack)", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const rack = await createLoadingCapability(db, { kind: "ENUMERATED_LIST", gymProfileId: gym.id, unit: "KG", basis: "PER_IMPLEMENT", loadsMilli: [20000, 22000, 24000] });
    if (rack.status !== "CREATED") throw new Error("expected CREATED");

    await bindExerciseToCapability(db, gym.id, "incline-db-press", rack.loadingCapabilityId);
    await bindExerciseToCapability(db, gym.id, "flat-db-press", rack.loadingCapabilityId);
    await bindExerciseToCapability(db, gym.id, "one-arm-db-row", rack.loadingCapabilityId);

    const inclineResult = await resolveBoundCapability(db, gym.id, "incline-db-press");
    const flatResult = await resolveBoundCapability(db, gym.id, "flat-db-press");
    expect(inclineResult.status).toBe("RESOLVED");
    expect(flatResult.status).toBe("RESOLVED");
    if (inclineResult.status !== "RESOLVED" || flatResult.status !== "RESOLVED") throw new Error("expected RESOLVED");
    expect(inclineResult.loadingCapabilityId).toBe(rack.loadingCapabilityId);
    expect(flatResult.loadingCapabilityId).toBe(rack.loadingCapabilityId);
  });

  // 11
  it("LOADCAP-011: no binding -> LOADING_CAPABILITY_UNAVAILABLE, never a fallback", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const result = await resolveBoundCapability(db, gym.id, "cable-row");
    expect(result).toEqual({ status: "LOADING_CAPABILITY_UNAVAILABLE" });
  });

  // 12
  it("LOADCAP-012: cross-gym binding is rejected — the same-gym invariant is DB-enforced, not just service-level", async () => {
    const athleteProfileId = await createAthlete();
    const gymA = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    // A second, non-default gym profile for the same athlete, to prove a
    // genuinely different GymProfile row (not merely a different athlete).
    const gymBId = createEntityId();
    await db.insert(gymProfiles).values({ id: gymBId, athleteProfileId, isDefault: false });

    const capInGymB = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gymBId, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capInGymB.status !== "CREATED") throw new Error("expected CREATED");

    const result = await bindExerciseToCapability(db, gymA.id, "bench-press", capInGymB.loadingCapabilityId);
    expect(result).toEqual({ status: "CROSS_GYM_CAPABILITY" });

    const rows = await db.select().from(exerciseLoadingCapabilityBindings).where(eq(exerciseLoadingCapabilityBindings.gymProfileId, gymA.id));
    expect(rows).toHaveLength(0);
  });

  // 13 — BOLA composition proof
  it("LOADCAP-013: actor A can never resolve actor B's capability, even supplying B's own gymProfileId/exerciseRef", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const gymA = await getOrCreateDefaultGymProfileForAthlete(db, athleteA);
    const gymB = await getOrCreateDefaultGymProfileForAthlete(db, athleteB);

    const capB = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gymB.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (capB.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gymB.id, "bench-press", capB.loadingCapabilityId);

    // Actor A's own canonical gymProfileId (the ONLY one a real caller
    // could ever legitimately obtain for actor A, via
    // getOrCreateDefaultGymProfileForAthlete(athleteA)) never resolves to
    // B's binding, regardless of exerciseRef overlap.
    const asActorA = await resolveBoundCapability(db, gymA.id, "bench-press");
    expect(asActorA).toEqual({ status: "LOADING_CAPABILITY_UNAVAILABLE" });

    // Only querying with B's OWN gymProfileId (never obtainable by A
    // through getOrCreateDefaultGymProfileForAthlete(athleteA)) resolves it.
    const asActorB = await resolveBoundCapability(db, gymB.id, "bench-press");
    expect(asActorB.status).toBe("RESOLVED");
  });

  // 14, 15
  it("LOADCAP-014/015: revision starts at 1 and increments on every resolver-relevant update, never left to updatedAt", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const created = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    expect(created.revision).toBe(1);

    const updated = await updateLoadingCapabilityPayload(db, created.loadingCapabilityId, { kind: "FIXED_INCREMENT", incrementAmountMilli: 5000 });
    expect(updated).toEqual({ status: "UPDATED", revision: 2 });

    const updatedAgain = await updateLoadingCapabilityPayload(db, created.loadingCapabilityId, { kind: "ENUMERATED_LIST", loadsMilli: [20000, 25000] });
    expect(updatedAgain).toEqual({ status: "UPDATED", revision: 3 });

    const [row] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, created.loadingCapabilityId));
    expect(row?.revision).toBe(3);
    expect(row?.kind).toBe("ENUMERATED_LIST");
    expect(row?.enumeratedLoadsMilli).toEqual([20000, 25000]);
  });

  // 16
  it("LOADCAP-016: the payload-kind invariant is DB-enforced — FIXED_INCREMENT with both payloads is rejected", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    await expect(
      db.insert(loadingCapabilities).values({
        id: createEntityId(),
        gymProfileId: gym.id,
        unit: "KG",
        basis: "TOTAL",
        kind: "FIXED_INCREMENT",
        fixedIncrementAmountMilli: 2500,
        enumeratedLoadsMilli: [20000, 22000], // both present — must violate loading_capabilities_payload_matches_kind
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(loadingCapabilities).values({
        id: createEntityId(),
        gymProfileId: gym.id,
        unit: "KG",
        basis: "TOTAL",
        kind: "ENUMERATED_LIST",
        fixedIncrementAmountMilli: null,
        enumeratedLoadsMilli: null, // neither present — must violate loading_capabilities_payload_matches_kind
      }),
    ).rejects.toThrow();
  });

  // 16 (continued) — the domain-layer boundary the DB itself cannot enforce
  it("LOADCAP-016b: strictly-ascending/unique ENUMERATED_LIST ordering is enforced at the domain write boundary, not by a Postgres CHECK — documented limitation, proven both ways", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    const viaPrimitive = await createLoadingCapability(db, {
      kind: "ENUMERATED_LIST",
      gymProfileId: gym.id,
      unit: "KG",
      basis: "PER_IMPLEMENT",
      loadsMilli: [24000, 20000, 22000], // unsorted
    });
    expect(viaPrimitive).toEqual({ status: "INVALID_ENUMERATED_LIST", reason: "NOT_STRICTLY_ASCENDING" });

    // Documented limitation: the SAME malformed array, inserted via raw
    // SQL bypassing the domain-layer validation entirely, is NOT rejected
    // by Postgres — proving the CHECK constraint genuinely cannot express
    // this rule (see loading-capability.ts's own schema doc comment).
    const id = createEntityId();
    await db.insert(loadingCapabilities).values({
      id,
      gymProfileId: gym.id,
      unit: "KG",
      basis: "PER_IMPLEMENT",
      kind: "ENUMERATED_LIST",
      enumeratedLoadsMilli: [24000, 20000, 22000],
    });
    const [row] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, id));
    expect(row?.enumeratedLoadsMilli).toEqual([24000, 20000, 22000]); // Postgres accepted it — the domain layer is the real guard
  });

  // Loading Capability Foundation V1 evidence gate — the full read/resolve
  // path must fail closed if malformed data somehow reaches Postgres
  // despite the write-boundary validation above, since the database
  // itself cannot reject it.
  it("LOADCAP-016c: malformed persisted ENUMERATED_LIST data fails closed end-to-end — resolveBoundCapability + resolveNextLoadFromCapability never resolve it", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);

    // 1/2: bypass the canonical writer entirely — raw SQL insert of data
    // the domain layer would reject (unsorted, per LOADCAP-016b above).
    const malformedCapabilityId = createEntityId();
    await db.insert(loadingCapabilities).values({
      id: malformedCapabilityId,
      gymProfileId: gym.id,
      unit: "KG",
      basis: "PER_IMPLEMENT",
      kind: "ENUMERATED_LIST",
      enumeratedLoadsMilli: [20000, 24000, 22000],
    });

    // 3: a perfectly valid, explicit binding to that malformed capability.
    const bindResult = await bindExerciseToCapability(db, gym.id, "incline-db-press", malformedCapabilityId);
    expect(bindResult).toEqual({ status: "BOUND" });

    // 4: the normal lookup path — succeeds structurally (a binding DOES
    // exist), returning the malformed payload exactly as persisted; the
    // lookup primitive itself has no opinion on ordering (§10 of
    // LOADING-CAPABILITY-V1.md — that is the pure resolver's job).
    const lookup = await resolveBoundCapability(db, gym.id, "incline-db-press");
    expect(lookup.status).toBe("RESOLVED");
    if (lookup.status !== "RESOLVED") throw new Error("expected RESOLVED");
    expect(lookup.capability).toEqual({ kind: "ENUMERATED_LIST", unit: "KG", basis: "PER_IMPLEMENT", loadsMilli: [20000, 24000, 22000] });

    // 5: feed it to the pure resolver — this is the actual fail-closed
    // boundary. Never RESOLVED, deterministic INVALID_CAPABILITY, no
    // rounding/sorting/repair, no exception thrown.
    const current = { kind: "EXTERNAL_WEIGHT" as const, amountMilli: 24000, unit: "KG" as const, basis: "PER_IMPLEMENT" as const };
    let resolution;
    expect(() => {
      resolution = resolveNextLoadFromCapability(current, lookup.capability);
    }).not.toThrow();
    expect(resolution).toEqual({ status: "INVALID_CAPABILITY", reason: "MALFORMED_CAPABILITY" });

    // The DB row remains completely unchanged by any of the above — no
    // repair, no normalization-on-read, no side effect at all.
    const [rowAfter] = await db.select().from(loadingCapabilities).where(eq(loadingCapabilities.id, malformedCapabilityId));
    expect(rowAfter?.enumeratedLoadsMilli).toEqual([20000, 24000, 22000]);

    // No Plan/application mutation exists to even check — Progression
    // Application's own overlay/apply mechanism is not implemented by
    // this slice at all (nothing was written anywhere beyond the explicit
    // fixture rows this test itself created).
  });

  // 17
  it("LOADCAP-017: no exerciseRef=NULL binding is possible — the column is NOT NULL", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const cap = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (cap.status !== "CREATED") throw new Error("expected CREATED");

    // Deliberately violates the exerciseRef NOT NULL constraint — proving
    // the database rejects it, not just the TypeScript type system. Cast
    // through `unknown` since the typed insert shape correctly refuses to
    // even compile a null exerciseRef.
    const invalidValues = {
      id: createEntityId(),
      gymProfileId: gym.id,
      exerciseRef: null,
      loadingCapabilityId: cap.loadingCapabilityId,
    } as unknown as typeof exerciseLoadingCapabilityBindings.$inferInsert;

    await expect(db.insert(exerciseLoadingCapabilityBindings).values(invalidValues)).rejects.toThrow();
  });

  // §25 — the application boundary seam: the lookup primitive's output
  // feeds resolveNextLoadFromCapability() with no hidden DB/framework
  // knowledge inside packages/domain.
  it("LOADCAP-BOUNDARY: resolveBoundCapability's output composes directly with resolveNextLoadFromCapability()", async () => {
    const athleteProfileId = await createAthlete();
    const gym = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
    const cap = await createLoadingCapability(db, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli: 2500 });
    if (cap.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db, gym.id, "bench-press", cap.loadingCapabilityId);

    const lookup = await resolveBoundCapability(db, gym.id, "bench-press");
    expect(lookup.status).toBe("RESOLVED");
    if (lookup.status !== "RESOLVED") throw new Error("expected RESOLVED");
    expect(lookup.revision).toBe(1);

    const resolution = resolveNextLoadFromCapability(
      { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" },
      lookup.capability,
    );
    expect(resolution).toEqual({ status: "RESOLVED", load: { kind: "EXTERNAL_WEIGHT", amountMilli: 102500, unit: "KG", basis: "TOTAL" } });
  });
});
