import type postgres from "postgres";
import {
  classifyIdentityImport,
  diffIdentityRows,
  IdentityImportCollisionError,
  type AthleteProfileRow,
  type AuthIdentityRow,
  type DogfoodIdentityState,
  type IdentityRows,
  type UserRow,
} from "./identity-import.js";

/**
 * UTC text with microseconds: exact, and independent of the session time zone.
 * Written back through `$n::text::timestamptz`: a bare timestamptz parameter goes
 * through postgres.js's Date serializer, which truncates to milliseconds.
 */
const utc = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const USER_COLUMNS = `id::text AS "id", status::text AS "status", ${utc("created_at")} AS "createdAt", ${utc("updated_at")} AS "updatedAt"`;
const IDENTITY_COLUMNS = `id::text AS "id", user_id::text AS "userId", provider::text AS "provider", provider_subject AS "providerSubject", ${utc("created_at")} AS "createdAt", ${utc("last_used_at")} AS "lastUsedAt"`;
const PROFILE_COLUMNS = `id::text AS "id", user_id::text AS "userId", experience_mode::text AS "experienceMode", unit_system::text AS "unitSystem", training_time_zone AS "trainingTimeZone", ${utc("created_at")} AS "createdAt", ${utc("updated_at")} AS "updatedAt"`;

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Exactly one real identity, chosen by subject prefix AND confirmed by the expected userId. Read-only. */
export async function readSourceIdentityRows(sql: postgres.Sql, subjectPrefix: string, expectedUserId: string): Promise<IdentityRows> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const identities = await tx.unsafe<AuthIdentityRow[]>(`SELECT ${IDENTITY_COLUMNS} FROM app.auth_identities WHERE starts_with(provider_subject, $1)`, [subjectPrefix]);
    const [authIdentity] = identities;
    if (identities.length !== 1 || authIdentity === undefined) throw new IdentityImportCollisionError([`subject prefix matched ${identities.length} identities, expected exactly 1`]);
    if (authIdentity.userId !== expectedUserId) throw new IdentityImportCollisionError(["subject prefix resolves to a different userId than --expect-user-id"]);
    const [user] = await tx.unsafe<UserRow[]>(`SELECT ${USER_COLUMNS} FROM app.users WHERE id = $1`, [expectedUserId]);
    const [athleteProfile] = await tx.unsafe<AthleteProfileRow[]>(`SELECT ${PROFILE_COLUMNS} FROM app.athlete_profiles WHERE user_id = $1`, [expectedUserId]);
    if (user === undefined || athleteProfile === undefined) throw new IdentityImportCollisionError(["source identity is incomplete"]);
    return { user, authIdentity, athleteProfile };
  });
}

async function countAppRows(sql: Queryable): Promise<number> {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' AND table_type = 'BASE TABLE'
  `;
  let total = 0;
  for (const { table_name } of tables) {
    const [row] = await sql.unsafe<[{ n: number }]>(`SELECT count(*)::int AS n FROM app."${table_name.replace(/"/g, '""')}"`);
    total += row.n;
  }
  return total;
}

export async function readDogfoodIdentityState(sql: Queryable, rows: IdentityRows): Promise<DogfoodIdentityState> {
  const { user, authIdentity, athleteProfile } = rows;
  const users = await sql.unsafe<UserRow[]>(`SELECT ${USER_COLUMNS} FROM app.users WHERE id = $1`, [user.id]);
  const authIdentities = await sql.unsafe<AuthIdentityRow[]>(
    `SELECT ${IDENTITY_COLUMNS} FROM app.auth_identities WHERE id = $1 OR user_id = $2 OR (provider::text = $3 AND provider_subject = $4)`,
    [authIdentity.id, user.id, authIdentity.provider, authIdentity.providerSubject],
  );
  const athleteProfiles = await sql.unsafe<AthleteProfileRow[]>(`SELECT ${PROFILE_COLUMNS} FROM app.athlete_profiles WHERE id = $1 OR user_id = $2`, [athleteProfile.id, user.id]);
  const [totals] = await sql<[{ users: number; authIdentities: number; athleteProfiles: number }]>`
    SELECT (SELECT count(*)::int FROM app.users) AS "users",
           (SELECT count(*)::int FROM app.auth_identities) AS "authIdentities",
           (SELECT count(*)::int FROM app.athlete_profiles) AS "athleteProfiles"
  `;
  return { users, authIdentities, athleteProfiles, totals, appRowsTotal: await countAppRows(sql) };
}

/** Any live `vostivo_dogfood_api` connection means an API/worker that could auto-provision during the import. */
export async function countRoleConnections(sql: Queryable, role: string): Promise<number> {
  const [row] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ${role}`;
  return row.n;
}

function exactRowsOf(state: DogfoodIdentityState): IdentityRows {
  const [user] = state.users;
  const [authIdentity] = state.authIdentities;
  const [athleteProfile] = state.athleteProfiles;
  if (user === undefined || authIdentity === undefined || athleteProfile === undefined) throw new IdentityImportCollisionError(["imported rows are missing"]);
  return { user, authIdentity, athleteProfile };
}

/**
 * The single transaction. Table locks block a concurrent auto-provisioning
 * insert; the state is re-classified under them, the three rows are inserted
 * and re-read, and any difference rolls everything back.
 */
export async function applyIdentityRows(sql: postgres.Sql, rows: IdentityRows): Promise<"IMPORTED" | "ALREADY_IMPORTED"> {
  const { user, authIdentity, athleteProfile } = rows;
  return sql.begin(async (tx): Promise<"IMPORTED" | "ALREADY_IMPORTED"> => {
    await tx.unsafe("LOCK TABLE app.users, app.auth_identities, app.athlete_profiles IN SHARE ROW EXCLUSIVE MODE");
    const classification = classifyIdentityImport(rows, await readDogfoodIdentityState(tx, rows));
    if (classification.kind === "COLLISION") throw new IdentityImportCollisionError(classification.reasons);
    if (classification.kind === "ALREADY_IMPORTED") return "ALREADY_IMPORTED";

    await tx.unsafe(`INSERT INTO app.users (id, status, created_at, updated_at) VALUES ($1::uuid, $2::app.user_status, $3::text::timestamptz, $4::text::timestamptz)`, [
      user.id,
      user.status,
      user.createdAt,
      user.updatedAt,
    ]);
    await tx.unsafe(
      `INSERT INTO app.auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
       VALUES ($1::uuid, $2::uuid, $3::app.auth_provider, $4, $5::text::timestamptz, $6::text::timestamptz)`,
      [authIdentity.id, authIdentity.userId, authIdentity.provider, authIdentity.providerSubject, authIdentity.createdAt, authIdentity.lastUsedAt],
    );
    await tx.unsafe(
      `INSERT INTO app.athlete_profiles (id, user_id, experience_mode, unit_system, training_time_zone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::app.experience_mode, $4::app.unit_system, $5, $6::text::timestamptz, $7::text::timestamptz)`,
      [athleteProfile.id, athleteProfile.userId, athleteProfile.experienceMode, athleteProfile.unitSystem, athleteProfile.trainingTimeZone, athleteProfile.createdAt, athleteProfile.updatedAt],
    );

    const differences = diffIdentityRows(rows, exactRowsOf(await readDogfoodIdentityState(tx, rows)));
    if (differences.length > 0) throw new IdentityImportCollisionError(differences);
    return "IMPORTED";
  });
}

/** After commit: exact rows, exactly three app rows, and the API's own subject -> ids join gives the same answer. */
export async function verifyImportedIdentity(sql: postgres.Sql, rows: IdentityRows): Promise<void> {
  const state = await readDogfoodIdentityState(sql, rows);
  const problems = diffIdentityRows(rows, exactRowsOf(state));
  if (state.appRowsTotal !== 3) problems.push(`expected exactly 3 app rows, found ${state.appRowsTotal}`);
  const resolved = await sql<{ userId: string; athleteProfileId: string }[]>`
    SELECT u.id::text AS "userId", p.id::text AS "athleteProfileId"
    FROM app.auth_identities i
    JOIN app.users u ON u.id = i.user_id
    JOIN app.athlete_profiles p ON p.user_id = u.id
    WHERE i.provider::text = ${rows.authIdentity.provider} AND i.provider_subject = ${rows.authIdentity.providerSubject}
  `;
  const [only] = resolved;
  if (resolved.length !== 1 || only?.userId !== rows.user.id || only.athleteProfileId !== rows.athleteProfile.id) {
    problems.push("subject does not resolve to the expected userId/athleteProfileId");
  }
  if (problems.length > 0) throw new IdentityImportCollisionError(problems);
}
