/**
 * TEST-ONLY, imported by source path so it never reaches a production build.
 * Integration tests delete and insert freely, so they run only against a
 * database that is disposable by name, on this machine. The shared `vostivo_dev`, `vostivo_manual` and dogfood
 * databases can never match. Messages never include a connection string.
 */
const DISPOSABLE_DATABASE_NAME = /^vostivo_disposable_[a-z0-9_]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUIRED_KEYS = ["DATABASE_URL", "MIGRATION_DATABASE_URL"] as const;

export class UnsafeTestDatabaseError extends Error {}

interface TestDatabaseTarget {
  readonly endpoint: string;
  readonly databaseName: string;
}

function parseTarget(key: string, value: string | undefined): TestDatabaseTarget {
  if (value === undefined || value === "") {
    throw new UnsafeTestDatabaseError(`Refusing integration tests: ${key} must be set explicitly.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeTestDatabaseError(`Refusing integration tests: ${key} is not a valid connection string.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeTestDatabaseError(`Refusing integration tests: ${key} is not a Postgres connection string.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UnsafeTestDatabaseError(`Refusing integration tests: ${key} must point at a loopback host.`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    throw new UnsafeTestDatabaseError(`Refusing integration tests: ${key} must name a vostivo_disposable_* database.`);
  }

  return { endpoint: `${url.hostname}:${url.port}`, databaseName };
}

export function assertDisposableTestDatabase(env: Record<string, string | undefined>): void {
  const [runtime, migration] = REQUIRED_KEYS.map((key) => parseTarget(key, env[key]));

  if (runtime?.endpoint !== migration?.endpoint || runtime?.databaseName !== migration?.databaseName) {
    throw new UnsafeTestDatabaseError("Refusing integration tests: DATABASE_URL and MIGRATION_DATABASE_URL must target the same database.");
  }
}

/** The validated URL. Replaces any implicit fallback to a shared database. */
export function requireDisposableDatabaseUrl(key: (typeof REQUIRED_KEYS)[number], env: Record<string, string | undefined> = readProcessEnv()): string {
  assertDisposableTestDatabase(env);
  return env[key] as string;
}

function readProcessEnv(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
}
