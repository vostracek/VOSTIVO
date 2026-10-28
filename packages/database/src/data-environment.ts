import postgres from "postgres";

/**
 * Dogfood Environment V1 — the second line of defence between the dogfood
 * database (Lukáš's real training data, its own Postgres instance on
 * 127.0.0.1:5433) and everything else (dev, acceptance, tests). The first
 * line is infrastructure: a separate container whose roles/passwords no
 * dev/test credential knows. This module makes a misconfiguration fail
 * loudly even if someone copies a dogfood connection string by hand.
 *
 * Three facts must agree, in BOTH directions:
 * - the declared `VOSTIVO_DATA_ENV` (`dogfood` only for the dogfood API/worker/tooling),
 * - the connected database's name (`vostivo_dogfood`),
 * - the database's own marker (`COMMENT ON DATABASE ... IS 'vostivo-data-env:dogfood'`).
 * A dogfood process never runs against a non-dogfood database, and a
 * non-dogfood process (dev API, tests, dev tooling) never runs against the
 * dogfood database.
 */
export const DATA_ENVIRONMENTS = ["dev", "manual", "dogfood"] as const;
export type DataEnvironment = (typeof DATA_ENVIRONMENTS)[number];

export const DOGFOOD_DATABASE_NAME = "vostivo_dogfood";
export const DOGFOOD_DATABASE_MARKER = "vostivo-data-env:dogfood";

export class DataEnvironmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataEnvironmentMismatchError";
  }
}

export interface DatabaseIdentity {
  readonly databaseName: string;
  /** The `COMMENT ON DATABASE` text, or null when none is set. */
  readonly marker: string | null;
}

/** Pure check of what a process declares against what it is connected to. Never logs connection strings. */
export function assertDataEnvironmentMatches(declared: DataEnvironment | undefined, identity: DatabaseIdentity): void {
  const looksDogfood = identity.databaseName === DOGFOOD_DATABASE_NAME || identity.marker === DOGFOOD_DATABASE_MARKER;
  if (declared === "dogfood") {
    if (identity.databaseName !== DOGFOOD_DATABASE_NAME || identity.marker !== DOGFOOD_DATABASE_MARKER) {
      throw new DataEnvironmentMismatchError(
        `VOSTIVO_DATA_ENV=dogfood requires database "${DOGFOOD_DATABASE_NAME}" carrying the dogfood marker; ` +
          `connected to "${identity.databaseName}" (${identity.marker === DOGFOOD_DATABASE_MARKER ? "dogfood marker" : "no dogfood marker"}). Refusing to start.`,
      );
    }
    return;
  }
  if (looksDogfood) {
    throw new DataEnvironmentMismatchError(
      `Connected to the dogfood database ("${identity.databaseName}") without VOSTIVO_DATA_ENV=dogfood. Refusing to start.`,
    );
  }
}

/** Reads the connected database's name and marker (any role that can connect may read both). */
export async function readDatabaseIdentity(databaseUrl: string): Promise<DatabaseIdentity> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const [row] = await sql<[{ database_name: string; marker: string | null }]>`
      SELECT current_database() AS database_name,
             shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS marker
    `;
    return { databaseName: row.database_name, marker: row.marker };
  } finally {
    await sql.end();
  }
}

/** Startup guard for the API, the worker and dev tooling: connects once, checks, disconnects. */
export async function assertDataEnvironment(declared: DataEnvironment | undefined, databaseUrl: string): Promise<void> {
  assertDataEnvironmentMatches(declared, await readDatabaseIdentity(databaseUrl));
}

/**
 * URL-only guard (no connection is opened) for everything that must never
 * touch dogfood: integration tests (vitest `setupFiles`, checked before any
 * test can connect — tests truncate/insert freely) and dev tooling (migrate,
 * role bootstrap, dev seed). Refuses a `VOSTIVO_DATA_ENV=dogfood` shell and
 * any DB URL naming the dogfood database. Never echoes a URL.
 */
export function assertNotDogfoodTarget(env: Record<string, string | undefined>, purpose: string): void {
  if (env.VOSTIVO_DATA_ENV === "dogfood") {
    throw new DataEnvironmentMismatchError(`Refusing to run ${purpose} with VOSTIVO_DATA_ENV=dogfood.`);
  }
  for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "MANUAL_DATABASE_URL"] as const) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    if (databaseNameOf(value) === DOGFOOD_DATABASE_NAME) {
      throw new DataEnvironmentMismatchError(`Refusing to run ${purpose}: ${key} points at the dogfood database.`);
    }
  }
}

/**
 * Dev tooling (migrate, bootstrap-roles/pgboss, seed-dev-plan): the URL
 * check above PLUS the connected database's own identity, so a renamed
 * or marker-carrying dogfood database is refused too.
 */
export async function assertDevToolingTarget(databaseUrl: string, purpose: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  assertNotDogfoodTarget(env, purpose);
  await assertDataEnvironment(undefined, databaseUrl);
}

function databaseNameOf(connectionString: string): string | null {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}
