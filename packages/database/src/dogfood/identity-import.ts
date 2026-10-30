import { createHash } from "node:crypto";
import { DataEnvironmentMismatchError } from "../data-environment.js";

/**
 * Dogfood Identity Import (Phase C) — moves exactly ONE real identity
 * (users + auth_identities + athlete_profiles row, same UUIDs) from
 * `vostivo_manual` into the empty dogfood database, so the same Supabase
 * subject keeps resolving to the same internal userId and a device binding
 * never hits BINDING_CONFLICT. No training data of any kind.
 *
 * Timestamps are carried as UTC text with microseconds (never JS Date, which
 * would truncate them), so the import is byte-exact.
 */
export const IDENTITY_SNAPSHOT_VERSION = 1;
export const IDENTITY_SOURCE_DATABASE = "vostivo_manual";

const LOCAL_SOURCE_HOSTS = new Set(["localhost", "127.0.0.1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface UserRow {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthIdentityRow {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly providerSubject: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface AthleteProfileRow {
  readonly id: string;
  readonly userId: string;
  readonly experienceMode: string;
  readonly unitSystem: string;
  readonly trainingTimeZone: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdentityRows {
  readonly user: UserRow;
  readonly authIdentity: AuthIdentityRow;
  readonly athleteProfile: AthleteProfileRow;
}

export interface IdentitySnapshot extends IdentityRows {
  readonly snapshotVersion: typeof IDENTITY_SNAPSHOT_VERSION;
  readonly sourceDatabase: typeof IDENTITY_SOURCE_DATABASE;
  readonly exportedAt: string;
  readonly sha256: string;
}

/** Every dogfood row that shares ANY identifying key with the snapshot, plus table totals. */
export interface DogfoodIdentityState {
  readonly users: readonly UserRow[];
  readonly authIdentities: readonly AuthIdentityRow[];
  readonly athleteProfiles: readonly AthleteProfileRow[];
  readonly totals: { readonly users: number; readonly authIdentities: number; readonly athleteProfiles: number };
  readonly appRowsTotal: number;
}

export type IdentityClassification =
  | { readonly kind: "IMPORTABLE" }
  | { readonly kind: "ALREADY_IMPORTED"; readonly drift: readonly string[] }
  | { readonly kind: "COLLISION"; readonly reasons: readonly string[] };

export class IdentityImportCollisionError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Identity import refused: ${reasons.join("; ")}`);
    this.name = "IdentityImportCollisionError";
  }
}

export const maskSubject = (subject: string): string => `${subject.slice(0, 8)}…`;

function rowsHash(rows: IdentityRows): string {
  return createHash("sha256").update(JSON.stringify([rows.user, rows.authIdentity, rows.athleteProfile])).digest("hex");
}

export function buildIdentitySnapshot(rows: IdentityRows, exportedAt: Date): IdentitySnapshot {
  return {
    snapshotVersion: IDENTITY_SNAPSHOT_VERSION,
    sourceDatabase: IDENTITY_SOURCE_DATABASE,
    exportedAt: exportedAt.toISOString(),
    user: rows.user,
    authIdentity: rows.authIdentity,
    athleteProfile: rows.athleteProfile,
    sha256: rowsHash(rows),
  };
}

/** The export reads only from the local acceptance database, never from any other source. */
export function assertIdentitySource(connectionString: string): void {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (databaseName !== IDENTITY_SOURCE_DATABASE || !LOCAL_SOURCE_HOSTS.has(url.hostname) || url.port !== "5432") {
    throw new DataEnvironmentMismatchError(`Identity source must be the local ${IDENTITY_SOURCE_DATABASE} database.`);
  }
}

/** Fixture subjects (`e2e-journey-…`, `local-manual-…`) are not UUIDs, so a real Supabase subject is required here. */
export function validateIdentitySnapshot(snapshot: IdentitySnapshot): string[] {
  const problems: string[] = [];
  const { user, authIdentity, athleteProfile } = snapshot;
  if (snapshot.snapshotVersion !== IDENTITY_SNAPSHOT_VERSION) problems.push("unsupported snapshot version");
  if ((snapshot.sourceDatabase as string) !== IDENTITY_SOURCE_DATABASE) problems.push(`source must be ${IDENTITY_SOURCE_DATABASE}`);
  if (rowsHash(snapshot) !== snapshot.sha256) problems.push("sha256 does not match the snapshot rows");
  if (authIdentity.provider !== "supabase") problems.push("provider must be supabase");
  if (!UUID.test(authIdentity.providerSubject)) problems.push("provider subject is not a real Supabase UUID (fixture?)");
  for (const [name, id] of [["users.id", user.id], ["auth_identities.id", authIdentity.id], ["athlete_profiles.id", athleteProfile.id]] as const) {
    if (!UUID_V7.test(id)) problems.push(`${name} is not a UUIDv7`);
  }
  if (user.status !== "ACTIVE") problems.push("user is not ACTIVE");
  if (authIdentity.userId !== user.id) problems.push("auth identity belongs to another user");
  if (athleteProfile.userId !== user.id) problems.push("athlete profile belongs to another user");
  return problems;
}

/** Field-by-field difference between what the snapshot says and what dogfood holds. */
export function diffIdentityRows(expected: IdentityRows, actual: IdentityRows): string[] {
  const differences: string[] = [];
  const compare = (table: string, want: object, got: object): void => {
    const gotValues = got as Record<string, unknown>;
    for (const [field, value] of Object.entries(want)) {
      if (value !== gotValues[field]) differences.push(`${table}.${field} differs`);
    }
  };
  compare("users", expected.user, actual.user);
  compare("auth_identities", expected.authIdentity, actual.authIdentity);
  compare("athlete_profiles", expected.athleteProfile, actual.athleteProfile);
  return differences;
}

/**
 * IMPORTABLE only into a completely empty dogfood database. ALREADY_IMPORTED
 * means the same ids, subject and links; mutable fields (a time zone the
 * athlete changed after the import) are only reported as drift, never
 * rewritten. Anything else is a COLLISION: fail closed, there is no
 * overwrite or delete path.
 */
export function classifyIdentityImport(snapshot: IdentityRows, state: DogfoodIdentityState): IdentityClassification {
  const { user, authIdentity, athleteProfile } = snapshot;
  const nothingMatched = state.users.length === 0 && state.authIdentities.length === 0 && state.athleteProfiles.length === 0;
  const { totals } = state;

  if (nothingMatched) {
    const reasons: string[] = [];
    if (totals.users > 0 || totals.authIdentities > 0 || totals.athleteProfiles > 0) {
      reasons.push(`dogfood already holds a different identity (users=${totals.users}, auth_identities=${totals.authIdentities}, athlete_profiles=${totals.athleteProfiles})`);
    }
    if (state.appRowsTotal > 0) reasons.push(`dogfood app tables are not empty (${state.appRowsTotal} rows)`);
    return reasons.length === 0 ? { kind: "IMPORTABLE" } : { kind: "COLLISION", reasons };
  }

  const reasons: string[] = [];
  const [foundUser] = state.users;
  const [foundIdentity] = state.authIdentities;
  const [foundProfile] = state.athleteProfiles;
  if (state.users.length !== 1 || foundUser?.id !== user.id) reasons.push("users row missing or mismatched");
  if (
    state.authIdentities.length !== 1 ||
    foundIdentity?.id !== authIdentity.id ||
    foundIdentity.userId !== user.id ||
    foundIdentity.provider !== authIdentity.provider ||
    foundIdentity.providerSubject !== authIdentity.providerSubject
  ) {
    reasons.push(`auth identity for subject ${maskSubject(authIdentity.providerSubject)} missing or bound differently (auto-provisioned before the import?)`);
  }
  if (state.athleteProfiles.length !== 1 || foundProfile?.id !== athleteProfile.id || foundProfile.userId !== user.id) {
    reasons.push("athlete_profiles row missing or mismatched");
  }
  if (totals.users !== 1 || totals.authIdentities !== 1 || totals.athleteProfiles !== 1) {
    reasons.push(`dogfood holds more than this one identity (users=${totals.users}, auth_identities=${totals.authIdentities}, athlete_profiles=${totals.athleteProfiles})`);
  }
  if (reasons.length > 0 || foundUser === undefined || foundIdentity === undefined || foundProfile === undefined) {
    return { kind: "COLLISION", reasons };
  }
  return { kind: "ALREADY_IMPORTED", drift: diffIdentityRows(snapshot, { user: foundUser, authIdentity: foundIdentity, athleteProfile: foundProfile }) };
}

export type IdentityImportOutcome = "DRY_RUN_IMPORTABLE" | "ALREADY_IMPORTED" | "IMPORTED";

/**
 * Order is the safety property: validate -> classify -> (dry-run stops here)
 * -> pre-import backup + restore-check -> single transaction -> verify. A
 * failure at any step throws before the next one; the backup is only taken
 * when there is really something to import.
 */
export async function runIdentityImport(params: {
  readonly snapshot: IdentitySnapshot;
  readonly apply: boolean;
  readonly readState: () => Promise<DogfoodIdentityState>;
  /** Runtime connections would mean a live API/worker that could auto-provision: must throw when any exist. */
  readonly assertNoRuntimeConnections: () => Promise<void>;
  readonly backupAndVerify: () => Promise<void>;
  /** The single transaction. Re-classifies under table locks and returns what actually happened. */
  readonly applyTransaction: () => Promise<"IMPORTED" | "ALREADY_IMPORTED">;
  readonly verifyAfterCommit: () => Promise<void>;
}): Promise<IdentityImportOutcome> {
  const problems = validateIdentitySnapshot(params.snapshot);
  if (problems.length > 0) throw new IdentityImportCollisionError(problems);

  const classification = classifyIdentityImport(params.snapshot, await params.readState());
  if (classification.kind === "COLLISION") throw new IdentityImportCollisionError(classification.reasons);
  if (classification.kind === "ALREADY_IMPORTED") return "ALREADY_IMPORTED";
  if (!params.apply) return "DRY_RUN_IMPORTABLE";

  await params.assertNoRuntimeConnections();
  await params.backupAndVerify();
  const outcome = await params.applyTransaction();
  if (outcome === "IMPORTED") await params.verifyAfterCommit();
  return outcome;
}
