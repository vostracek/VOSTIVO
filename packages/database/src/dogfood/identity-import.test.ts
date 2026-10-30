import { describe, expect, it, vi } from "vitest";
import {
  assertIdentitySource,
  buildIdentitySnapshot,
  classifyIdentityImport,
  diffIdentityRows,
  IdentityImportCollisionError,
  runIdentityImport,
  validateIdentitySnapshot,
  type DogfoodIdentityState,
  type IdentityRows,
  type IdentitySnapshot,
} from "./identity-import.js";

const USER_ID = "01a1603f-0000-7000-8000-000000000001";
const ROWS: IdentityRows = {
  user: { id: USER_ID, status: "ACTIVE", createdAt: "2026-10-21T20:56:04.714675Z", updatedAt: "2026-10-21T20:56:04.714675Z" },
  authIdentity: {
    id: "01a1603f-0000-7000-8000-000000000002",
    userId: USER_ID,
    provider: "supabase",
    providerSubject: "11111111-2222-4333-8444-555555555555",
    createdAt: "2026-10-21T20:56:04.714675Z",
    lastUsedAt: null,
  },
  athleteProfile: {
    id: "01a1603f-0000-7000-8000-000000000003",
    userId: USER_ID,
    experienceMode: "GUIDED",
    unitSystem: "METRIC",
    trainingTimeZone: "Europe/Prague",
    createdAt: "2026-10-21T20:56:04.714675Z",
    updatedAt: "2026-10-21T20:56:04.714675Z",
  },
};
const SNAPSHOT = buildIdentitySnapshot(ROWS, new Date("2026-10-30T12:00:00Z"));
const EMPTY: DogfoodIdentityState = { users: [], authIdentities: [], athleteProfiles: [], totals: { users: 0, authIdentities: 0, athleteProfiles: 0 }, appRowsTotal: 0 };
const IMPORTED: DogfoodIdentityState = {
  users: [ROWS.user],
  authIdentities: [ROWS.authIdentity],
  athleteProfiles: [ROWS.athleteProfile],
  totals: { users: 1, authIdentities: 1, athleteProfiles: 1 },
  appRowsTotal: 3,
};

const resnapshot = (rows: IdentityRows): IdentitySnapshot => buildIdentitySnapshot(rows, new Date("2026-10-30T12:00:00Z"));

describe("snapshot validation", () => {
  it("IDENTITY-001: a real, consistent identity is valid", () => {
    expect(validateIdentitySnapshot(SNAPSHOT)).toEqual([]);
  });

  it("IDENTITY-002: a fixture subject is refused", () => {
    const rows = { ...ROWS, authIdentity: { ...ROWS.authIdentity, providerSubject: "e2e-journey-1792424330" } };
    expect(validateIdentitySnapshot(resnapshot(rows))).toEqual(["provider subject is not a real Supabase UUID (fixture?)"]);
  });

  it("IDENTITY-003: a tampered snapshot fails its sha256", () => {
    const tampered: IdentitySnapshot = { ...SNAPSHOT, user: { ...SNAPSHOT.user, status: "SUSPENDED" } };
    expect(validateIdentitySnapshot(tampered)).toContain("sha256 does not match the snapshot rows");
  });

  it("IDENTITY-004: broken links, non-ACTIVE users and non-UUIDv7 ids are refused", () => {
    const rows: IdentityRows = {
      user: { ...ROWS.user, status: "SUSPENDED" },
      authIdentity: { ...ROWS.authIdentity, userId: "01a1603f-0000-7000-8000-000000000009" },
      athleteProfile: { ...ROWS.athleteProfile, id: "11111111-2222-4333-8444-555555555555" },
    };
    expect(validateIdentitySnapshot(resnapshot(rows))).toEqual(["athlete_profiles.id is not a UUIDv7", "user is not ACTIVE", "auth identity belongs to another user"]);
  });

  it("IDENTITY-005: the source must be local vostivo_manual", () => {
    expect(() => assertIdentitySource("postgres://u:p@localhost:5432/vostivo_manual")).not.toThrow();
    for (const bad of ["postgres://u:p@localhost:5432/vostivo_dev", "postgres://u:p@127.0.0.1:5433/vostivo_dogfood", "postgres://u:p@db.example.com:5432/vostivo_manual"]) {
      expect(() => assertIdentitySource(bad)).toThrow();
    }
  });
});

describe("classification", () => {
  it("IDENTITY-010: a completely empty dogfood database is importable", () => {
    expect(classifyIdentityImport(ROWS, EMPTY)).toEqual({ kind: "IMPORTABLE" });
  });

  it("IDENTITY-011: exact rows -> ALREADY_IMPORTED without drift", () => {
    expect(classifyIdentityImport(ROWS, IMPORTED)).toEqual({ kind: "ALREADY_IMPORTED", drift: [] });
  });

  it("IDENTITY-012: later athlete changes are drift, not a collision", () => {
    const state = { ...IMPORTED, athleteProfiles: [{ ...ROWS.athleteProfile, trainingTimeZone: "Europe/Berlin" }], appRowsTotal: 50 };
    expect(classifyIdentityImport(ROWS, state)).toEqual({ kind: "ALREADY_IMPORTED", drift: ["athlete_profiles.trainingTimeZone differs"] });
  });

  it("IDENTITY-013: the same subject auto-provisioned under another user is a collision", () => {
    const state: DogfoodIdentityState = { ...EMPTY, authIdentities: [{ ...ROWS.authIdentity, id: "01a1603f-0000-7000-8000-00000000000a", userId: "01a1603f-0000-7000-8000-00000000000b" }], totals: { users: 1, authIdentities: 1, athleteProfiles: 1 }, appRowsTotal: 3 };
    const result = classifyIdentityImport(ROWS, state);
    expect(result.kind).toBe("COLLISION");
    expect(JSON.stringify(result)).toContain("auto-provisioned");
    expect(JSON.stringify(result)).not.toContain(ROWS.authIdentity.providerSubject);
  });

  it("IDENTITY-014: a different identity already in dogfood is a collision", () => {
    expect(classifyIdentityImport(ROWS, { ...EMPTY, totals: { users: 1, authIdentities: 1, athleteProfiles: 1 }, appRowsTotal: 3 }).kind).toBe("COLLISION");
  });

  it("IDENTITY-015: non-identity rows in an otherwise identity-free database are a collision", () => {
    expect(classifyIdentityImport(ROWS, { ...EMPTY, appRowsTotal: 1 })).toEqual({ kind: "COLLISION", reasons: ["dogfood app tables are not empty (1 rows)"] });
  });

  it("IDENTITY-016: a partial import (user without profile) is a collision", () => {
    const state: DogfoodIdentityState = { ...EMPTY, users: [ROWS.user], totals: { users: 1, authIdentities: 0, athleteProfiles: 0 }, appRowsTotal: 1 };
    expect(classifyIdentityImport(ROWS, state).kind).toBe("COLLISION");
  });

  it("IDENTITY-017: an extra identity next to the imported one is a collision", () => {
    expect(classifyIdentityImport(ROWS, { ...IMPORTED, totals: { users: 2, authIdentities: 2, athleteProfiles: 2 } }).kind).toBe("COLLISION");
  });

  it("IDENTITY-018: the diff is field-exact, including microseconds", () => {
    const other = { ...ROWS, user: { ...ROWS.user, createdAt: "2026-10-21T20:56:04.714000Z" } };
    expect(diffIdentityRows(ROWS, other)).toEqual(["users.createdAt differs"]);
  });
});

describe("orchestration order", () => {
  function harness(state: DogfoodIdentityState, overrides: Partial<Parameters<typeof runIdentityImport>[0]> = {}) {
    const calls: string[] = [];
    const step = (name: string) => () => {
      calls.push(name);
      return Promise.resolve();
    };
    const params = {
      snapshot: SNAPSHOT,
      apply: true,
      readState: () => Promise.resolve(state),
      assertNoRuntimeConnections: step("no-runtime"),
      backupAndVerify: step("backup"),
      applyTransaction: vi.fn(() => {
        calls.push("tx");
        return Promise.resolve<"IMPORTED">("IMPORTED");
      }),
      verifyAfterCommit: step("verify"),
      ...overrides,
    };
    return { params, calls };
  }

  it("IDENTITY-020: dry-run is the default path and touches nothing", async () => {
    const { params, calls } = harness(EMPTY, { apply: false });
    await expect(runIdentityImport(params)).resolves.toBe("DRY_RUN_IMPORTABLE");
    expect(calls).toEqual([]);
  });

  it("IDENTITY-021: --apply runs runtime check -> backup -> transaction -> verification, in that order", async () => {
    const { params, calls } = harness(EMPTY);
    await expect(runIdentityImport(params)).resolves.toBe("IMPORTED");
    expect(calls).toEqual(["no-runtime", "backup", "tx", "verify"]);
  });

  it("IDENTITY-022: a failed backup or restore-check means no transaction", async () => {
    const { params, calls } = harness(EMPTY, { backupAndVerify: () => Promise.reject(new Error("Restore-check failed")) });
    await expect(runIdentityImport(params)).rejects.toThrow("Restore-check failed");
    expect(calls).toEqual(["no-runtime"]);
  });

  it("IDENTITY-023: a live API/worker connection stops --apply before the backup", async () => {
    const { params, calls } = harness(EMPTY, { assertNoRuntimeConnections: () => Promise.reject(new Error("runtime connected")) });
    await expect(runIdentityImport(params)).rejects.toThrow("runtime connected");
    expect(calls).toEqual([]);
  });

  it("IDENTITY-024: a repeated run is a no-op without a backup", async () => {
    const { params, calls } = harness(IMPORTED);
    await expect(runIdentityImport(params)).resolves.toBe("ALREADY_IMPORTED");
    expect(calls).toEqual([]);
  });

  it("IDENTITY-025: a collision stops before anything is written, also in dry-run", async () => {
    const collision = { ...EMPTY, appRowsTotal: 1 };
    for (const apply of [true, false]) {
      const { params, calls } = harness(collision, { apply });
      await expect(runIdentityImport(params)).rejects.toThrow(IdentityImportCollisionError);
      expect(calls).toEqual([]);
    }
  });

  it("IDENTITY-026: an invalid snapshot never reaches the database", async () => {
    const readState = vi.fn(() => Promise.resolve(EMPTY));
    const { params } = harness(EMPTY, { snapshot: { ...SNAPSHOT, sha256: "0" }, readState });
    await expect(runIdentityImport(params)).rejects.toThrow(/sha256/);
    expect(readState).not.toHaveBeenCalled();
  });
});
