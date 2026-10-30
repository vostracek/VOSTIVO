import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import { createLogger } from "@vostivo/observability";
import {
  assertDataEnvironment,
  DataEnvironmentMismatchError,
  DOGFOOD_DATABASE_MARKER,
  DOGFOOD_DATABASE_NAME,
  readDatabaseIdentity,
} from "../data-environment.js";
import {
  assertIdentitySource,
  buildIdentitySnapshot,
  IdentityImportCollisionError,
  maskSubject,
  runIdentityImport,
  validateIdentitySnapshot,
  type IdentityImportOutcome,
  type IdentitySnapshot,
} from "./identity-import.js";
import { applyIdentityRows, countRoleConnections, readDogfoodIdentityState, readSourceIdentityRows, verifyImportedIdentity } from "./identity-import-sql.js";
import { migrateBehindPreMigrationBackup } from "./migration-gate.js";
import { backupBaseName, compareWithManifest, MANIFEST_VERSION, parseBackupBaseName, type BackupManifest, type RestoreVerification } from "./manifest.js";
import { BACKUP_REASONS, decideRetention, type BackupEntry, type BackupReason } from "./retention.js";
import {
  assertDogfoodConnectionTarget,
  assertOutsideRepository,
  DOGFOOD_API_HOST,
  DOGFOOD_API_PORT,
  DOGFOOD_BACKUP_DIR,
  DOGFOOD_CONFIG_DIR,
  DOGFOOD_CONTAINER,
  DOGFOOD_HOST,
  DOGFOOD_OWNER_ROLE,
  DOGFOOD_PORT,
  DOGFOOD_RUNTIME_ROLE,
  POSTGRES_IMAGE,
  RESTORE_CHECK_CONTAINER,
  RESTORE_CHECK_DATABASE,
} from "./target.js";

/**
 * Dogfood Environment V1 — the ONLY tool that writes to the dogfood
 * instance's schema/roles, and the only backup/restore-check tool.
 *
 * Deliberately has NO reset/drop/wipe command: nothing here issues DROP
 * DATABASE/SCHEMA/TABLE/ROLE against the dogfood instance. The only thing
 * ever removed is the ephemeral restore-check container (exact fixed name +
 * label, no volume) and, with `prune --apply`, backup files this tool wrote.
 * Secrets are generated into ~/.config/vostivo/dogfood (mode 600) and are
 * never printed or logged.
 */
const logger = createLogger({ serviceName: "dogfood" });

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const COMPOSE_FILE = join(REPOSITORY_ROOT, "infra", "dogfood", "docker-compose.yml");
const COMPOSE_ENV = join(DOGFOOD_CONFIG_DIR, "compose.env");
const ADMIN_ENV = join(DOGFOOD_CONFIG_DIR, "admin.env");
const RUNTIME_ENV = join(DOGFOOD_CONFIG_DIR, "runtime.env");
const RESTORE_CHECK_LABEL = "vostivo.dogfood.restorecheck=true";
const APP_SCHEMA = "app";
const PGBOSS_SCHEMA = "pgboss";
/** base64url output only — safe inside a URL and inside a single-quoted SQL literal. */
const PASSWORD_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;

interface AdminConfig {
  readonly adminDatabaseUrl: string;
  readonly runtimePassword: string;
}

// ---------------------------------------------------------------- config

function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

async function writeSecretFile(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

/** Creates the three config files once. Never overwrites (no silent rotation). */
export async function initConfig(supabaseUrl: string | undefined): Promise<void> {
  assertOutsideRepository(DOGFOOD_CONFIG_DIR, REPOSITORY_ROOT);
  if (supabaseUrl === undefined || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
    throw new Error("DOGFOOD_SUPABASE_URL must be set to the Supabase project URL (https://<ref>.supabase.co).");
  }
  for (const path of [COMPOSE_ENV, ADMIN_ENV, RUNTIME_ENV]) {
    if (existsSync(path)) throw new Error(`${path} already exists — refusing to overwrite dogfood credentials.`);
  }
  await mkdir(DOGFOOD_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(DOGFOOD_CONFIG_DIR, 0o700);

  const ownerPassword = generatePassword();
  const runtimePassword = generatePassword();
  const base = `${DOGFOOD_HOST}:${DOGFOOD_PORT}/${DOGFOOD_DATABASE_NAME}`;
  await writeSecretFile(COMPOSE_ENV, ["# Dogfood Postgres owner password (docker compose --env-file). Never commit.", `VOSTIVO_DOGFOOD_OWNER_PASSWORD=${ownerPassword}`]);
  await writeSecretFile(ADMIN_ENV, [
    "# Dogfood admin tooling (pnpm dogfood ...). Never commit.",
    "VOSTIVO_DATA_ENV=dogfood",
    `DOGFOOD_ADMIN_DATABASE_URL=postgres://${DOGFOOD_OWNER_ROLE}:${ownerPassword}@${base}`,
    `DOGFOOD_RUNTIME_PASSWORD=${runtimePassword}`,
  ]);
  await writeSecretFile(RUNTIME_ENV, [
    "# Dogfood API + worker runtime (node --env-file). Never commit.",
    "NODE_ENV=development",
    "VOSTIVO_DATA_ENV=dogfood",
    // Loopback only: the dogfood API is never exposed to the LAN (a later Tailscale Serve proxies this endpoint).
    `HOST=${DOGFOOD_API_HOST}`,
    `PORT=${DOGFOOD_API_PORT}`,
    `DATABASE_URL=postgres://${DOGFOOD_RUNTIME_ROLE}:${runtimePassword}@${base}`,
    `SUPABASE_URL=${supabaseUrl}`,
  ]);
  logger.info("Dogfood config written (mode 600, values not printed)", { dir: DOGFOOD_CONFIG_DIR, files: ["compose.env", "admin.env", "runtime.env"] });
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator > 0) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

async function loadAdminConfig(): Promise<AdminConfig> {
  if (!existsSync(ADMIN_ENV)) throw new Error(`${ADMIN_ENV} not found — run \`pnpm dogfood init-config\` first.`);
  const values = parseEnvFile(await readFile(ADMIN_ENV, "utf8"));
  if (values.VOSTIVO_DATA_ENV !== "dogfood") throw new DataEnvironmentMismatchError("admin.env must declare VOSTIVO_DATA_ENV=dogfood.");
  const adminDatabaseUrl = values.DOGFOOD_ADMIN_DATABASE_URL;
  const runtimePassword = values.DOGFOOD_RUNTIME_PASSWORD;
  if (adminDatabaseUrl === undefined || runtimePassword === undefined) throw new Error("admin.env is incomplete.");
  assertDogfoodConnectionTarget(adminDatabaseUrl, DOGFOOD_OWNER_ROLE);
  if (!PASSWORD_FORMAT.test(runtimePassword)) throw new Error("DOGFOOD_RUNTIME_PASSWORD has an unexpected format — refusing to use it in a DDL statement.");
  return { adminDatabaseUrl, runtimePassword };
}

// ---------------------------------------------------------------- docker

function run(command: string, args: readonly string[], options: { stdinFile?: string; stdoutFile?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: [options.stdinFile === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const { stdout: childStdout, stderr: childStderr } = child;
    if (childStdout === null || childStderr === null) throw new Error("spawn did not provide stdout/stderr pipes");
    let stdout = "";
    let stderr = "";
    if (options.stdinFile !== undefined && child.stdin !== null) createReadStream(options.stdinFile).pipe(child.stdin);
    // With a stdout file, resolve only once the file is fully flushed, not merely when the process exits.
    const fileWritten = new Promise<void>((resolveFile, rejectFile) => {
      if (options.stdoutFile === undefined) {
        childStdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        resolveFile();
        return;
      }
      const file = createWriteStream(options.stdoutFile, { mode: 0o600, flags: "wx" });
      file.on("finish", resolveFile);
      file.on("error", rejectFile);
      childStdout.pipe(file);
    });
    childStderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) fileWritten.then(() => resolvePromise(stdout), reject);
      else reject(new Error(`${command} ${args[0] ?? ""} exited with ${code}: ${stderr.trim().slice(0, 2000)}`));
    });
  });
}

async function containerState(name: string): Promise<string | null> {
  try {
    return (await run("docker", ["inspect", "-f", "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}", name])).trim();
  } catch {
    return null;
  }
}

/** The container dumped from must be the one published on 127.0.0.1:5433 — the same instance the guard checked. */
async function assertDogfoodContainerPublishing(): Promise<void> {
  const mapping = (await run("docker", ["port", DOGFOOD_CONTAINER, "5432/tcp"])).trim();
  if (mapping !== `${DOGFOOD_HOST}:${DOGFOOD_PORT}`) {
    throw new DataEnvironmentMismatchError(`${DOGFOOD_CONTAINER} publishes "${mapping}", expected ${DOGFOOD_HOST}:${DOGFOOD_PORT} only.`);
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

export async function up(): Promise<void> {
  if (!existsSync(COMPOSE_ENV)) throw new Error(`${COMPOSE_ENV} not found — run \`pnpm dogfood init-config\` first.`);
  await run("docker", ["compose", "-f", COMPOSE_FILE, "--env-file", COMPOSE_ENV, "up", "-d"]);
  await waitFor(async () => (await containerState(DOGFOOD_CONTAINER)) === "running/healthy", `${DOGFOOD_CONTAINER} to become healthy`);
  await assertDogfoodContainerPublishing();
  logger.info("Dogfood Postgres is up", { container: DOGFOOD_CONTAINER, published: `${DOGFOOD_HOST}:${DOGFOOD_PORT}` });
}

// ---------------------------------------------------------------- bootstrap

function journalMigrationCount(): Promise<number> {
  return readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8").then((text) => (JSON.parse(text) as { entries: unknown[] }).entries.length);
}

async function appliedMigrationCount(sql: postgres.Sql): Promise<number> {
  const [{ present }] = await sql<[{ present: boolean }]>`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
  if (!present) return 0;
  const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return n;
}

/**
 * Idempotent: marker -> (backup + restore-check if migrations are pending
 * on a non-empty schema) -> runtime role -> migrations -> pg-boss -> grants.
 * Never drops anything.
 */
export async function bootstrap(): Promise<void> {
  const config = await loadAdminConfig();
  const identity = await readDatabaseIdentity(config.adminDatabaseUrl);
  if (identity.databaseName !== DOGFOOD_DATABASE_NAME) throw new DataEnvironmentMismatchError(`Connected to "${identity.databaseName}", expected ${DOGFOOD_DATABASE_NAME}.`);

  const sql = postgres(config.adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  try {
    if (identity.marker !== DOGFOOD_DATABASE_MARKER) {
      await sql.unsafe(`COMMENT ON DATABASE ${DOGFOOD_DATABASE_NAME} IS '${DOGFOOD_DATABASE_MARKER}'`);
      logger.info("Dogfood marker set", { database: DOGFOOD_DATABASE_NAME });
    }
    await assertDataEnvironment("dogfood", config.adminDatabaseUrl);

    const [{ exists }] = await sql<[{ exists: boolean }]>`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${DOGFOOD_RUNTIME_ROLE}) AS exists`;
    // NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS: the runtime role can never run DDL or create roles.
    const roleOptions = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${config.runtimePassword}'`;
    await sql.unsafe(exists ? `ALTER ROLE ${DOGFOOD_RUNTIME_ROLE} WITH ${roleOptions}` : `CREATE ROLE ${DOGFOOD_RUNTIME_ROLE} WITH ${roleOptions}`);
    logger.info(exists ? "Runtime role existed; attributes/password re-applied" : "Runtime role created", { role: DOGFOOD_RUNTIME_ROLE });

    const appliedMigrations = await appliedMigrationCount(sql);
    const journalMigrations = await journalMigrationCount();
    logger.info("Migration state", { applied: appliedMigrations, pending: journalMigrations - appliedMigrations });
    const outcome = await migrateBehindPreMigrationBackup({
      appliedMigrations,
      journalMigrations,
      backupAndVerify: async () => {
        logger.info("Migrations pending on an existing dogfood schema — pre-migration backup + restore-check first");
        await verifyBackup(await createBackup("pre-migration"));
      },
      migrate: () => migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER }),
    });
    logger.info("Migrations applied", { outcome, applied: await appliedMigrationCount(sql) });

    const pgBoss = new PgBoss({ connectionString: config.adminDatabaseUrl, migrate: true, supervise: false, schedule: false });
    await pgBoss.start();
    await pgBoss.stop();

    const statements = [
      // Only the dogfood runtime role may connect to dogfood; nobody but the owner to the maintenance DB.
      `REVOKE ALL ON DATABASE ${DOGFOOD_DATABASE_NAME} FROM PUBLIC`,
      `REVOKE ALL ON DATABASE postgres FROM PUBLIC`,
      `GRANT CONNECT ON DATABASE ${DOGFOOD_DATABASE_NAME} TO ${DOGFOOD_RUNTIME_ROLE}`,
      `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      ...[APP_SCHEMA, PGBOSS_SCHEMA].flatMap((schema) => [
        `GRANT USAGE ON SCHEMA ${schema} TO ${DOGFOOD_RUNTIME_ROLE}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${DOGFOOD_RUNTIME_ROLE}`,
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${DOGFOOD_RUNTIME_ROLE}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${DOGFOOD_OWNER_ROLE} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DOGFOOD_RUNTIME_ROLE}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${DOGFOOD_OWNER_ROLE} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${DOGFOOD_RUNTIME_ROLE}`,
      ]),
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO ${DOGFOOD_RUNTIME_ROLE}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${DOGFOOD_OWNER_ROLE} IN SCHEMA ${PGBOSS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO ${DOGFOOD_RUNTIME_ROLE}`,
      `ALTER ROLE ${DOGFOOD_RUNTIME_ROLE} SET search_path = "${APP_SCHEMA}", public`,
    ];
    for (const statement of statements) await sql.unsafe(statement);
    logger.info("Dogfood bootstrap complete", { database: DOGFOOD_DATABASE_NAME, runtimeRole: DOGFOOD_RUNTIME_ROLE });
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------- backup

interface ControlData {
  readonly migrations: BackupManifest["migrations"];
  readonly tableRowCounts: Record<string, number>;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Row counts of every app/drizzle base table + migration state — the manifest's control data. */
async function readControlData(sql: postgres.Sql | postgres.TransactionSql): Promise<ControlData> {
  const tables = await sql<{ table_schema: string; table_name: string }[]>`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema IN ('app', 'drizzle') AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `;
  const tableRowCounts: Record<string, number> = {};
  for (const { table_schema, table_name } of tables) {
    const [{ n }] = await sql.unsafe<[{ n: number }]>(`SELECT count(*)::int AS n FROM ${quoteIdent(table_schema)}.${quoteIdent(table_name)}`);
    tableRowCounts[`${table_schema}.${table_name}`] = n;
  }
  const [migrations] = await sql<[{ count: number; latest: string | null }]>`
    SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations
  `;
  return { migrations: { count: migrations.count, latestCreatedAt: migrations.latest }, tableRowCounts };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function prepareBackupDir(): Promise<void> {
  assertOutsideRepository(DOGFOOD_BACKUP_DIR, REPOSITORY_ROOT);
  await mkdir(DOGFOOD_BACKUP_DIR, { recursive: true, mode: 0o700 });
  await chmod(DOGFOOD_BACKUP_DIR, 0o700);
}

/**
 * `pg_dump -Fc` from inside the dogfood container, using a snapshot exported
 * by the transaction that also counts the rows — dump and manifest describe
 * the same instant. Returns the dump path.
 */
export async function createBackup(reason: BackupReason): Promise<string> {
  const config = await loadAdminConfig();
  await assertDataEnvironment("dogfood", config.adminDatabaseUrl);
  await assertDogfoodContainerPublishing();
  await prepareBackupDir();

  const createdAt = new Date();
  const baseName = backupBaseName(createdAt, reason);
  const dumpPath = join(DOGFOOD_BACKUP_DIR, `${baseName}.dump`);
  const partialPath = `${dumpPath}.partial`;
  const identity = await readDatabaseIdentity(config.adminDatabaseUrl);

  const sql = postgres(config.adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  let control: ControlData;
  let serverVersion: string;
  try {
    [control, serverVersion] = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const [{ snapshot }] = await tx<[{ snapshot: string }]>`SELECT pg_export_snapshot() AS snapshot`;
      const [{ server_version }] = await tx<[{ server_version: string }]>`SHOW server_version`;
      const data = await readControlData(tx);
      await run(
        "docker",
        ["exec", DOGFOOD_CONTAINER, "pg_dump", "--format=custom", `--snapshot=${snapshot}`, "-U", DOGFOOD_OWNER_ROLE, "-d", DOGFOOD_DATABASE_NAME],
        { stdoutFile: partialPath },
      );
      return [data, server_version] as const;
    });
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  } finally {
    await sql.end();
  }

  await rename(partialPath, dumpPath);
  const sha256 = await sha256File(dumpPath);
  const { size } = await stat(dumpPath);
  const manifest: BackupManifest = {
    manifestVersion: MANIFEST_VERSION,
    dumpFile: `${baseName}.dump`,
    createdAt: createdAt.toISOString(),
    reason,
    sha256,
    sizeBytes: size,
    source: { databaseName: identity.databaseName, marker: identity.marker, serverVersion },
    migrations: control.migrations,
    tableRowCounts: control.tableRowCounts,
  };
  await writeSecretFile(join(DOGFOOD_BACKUP_DIR, `${baseName}.sha256`), [`${sha256}  ${baseName}.dump`]);
  await writeSecretFile(join(DOGFOOD_BACKUP_DIR, `${baseName}.manifest.json`), [JSON.stringify(manifest, null, 2)]);
  const totalRows = Object.values(control.tableRowCounts).reduce((sum, n) => sum + n, 0);
  logger.info("Dogfood backup written", { dump: dumpPath, sizeBytes: size, sha256, tables: Object.keys(control.tableRowCounts).length, totalRows, migrations: control.migrations.count });
  return dumpPath;
}

// ---------------------------------------------------------------- restore check

async function restoreCheckPsql(query: string): Promise<string> {
  return run("docker", ["exec", RESTORE_CHECK_CONTAINER, "psql", "-U", "postgres", "-d", RESTORE_CHECK_DATABASE, "-v", "ON_ERROR_STOP=1", "-tAc", query]);
}

async function removeRestoreCheckContainer(): Promise<void> {
  if ((await containerState(RESTORE_CHECK_CONTAINER)) === null) return;
  const labels = (await run("docker", ["inspect", "-f", "{{json .Config.Labels}}", RESTORE_CHECK_CONTAINER])).trim();
  const [key] = RESTORE_CHECK_LABEL.split("=");
  if (!labels.includes(`"${key}":"true"`)) throw new Error(`A container named ${RESTORE_CHECK_CONTAINER} exists without the restore-check label — refusing to touch it.`);
  await run("docker", ["rm", "-f", RESTORE_CHECK_CONTAINER]);
}

/**
 * Restores a dump into a throwaway container (`--network none`, data dir on
 * tmpfs, no volume, no published port) under the fixed name
 * `vostivo_dogfood_restorecheck`, then compares its control data with the
 * manifest. Never restores into the dogfood instance.
 */
export async function verifyBackup(dumpPath: string): Promise<RestoreVerification> {
  const baseName = dumpPath.replace(/^.*\//, "").replace(/\.dump$/, "");
  if (parseBackupBaseName(baseName) === null || join(DOGFOOD_BACKUP_DIR, `${baseName}.dump`) !== dumpPath) {
    throw new Error(`Not a dogfood backup in ${DOGFOOD_BACKUP_DIR}: ${dumpPath}`);
  }
  const manifest = JSON.parse(await readFile(join(DOGFOOD_BACKUP_DIR, `${baseName}.manifest.json`), "utf8")) as BackupManifest;
  const sidecarHash = (await readFile(join(DOGFOOD_BACKUP_DIR, `${baseName}.sha256`), "utf8")).split(/\s+/)[0];
  const actualHash = await sha256File(dumpPath);
  const sha256Matched = actualHash === manifest.sha256 && actualHash === sidecarHash;
  const mismatches: string[] = sha256Matched ? [] : ["sha256 does not match the manifest/.sha256"];

  if (sha256Matched) {
    await removeRestoreCheckContainer();
    try {
      await run("docker", [
        "run", "-d", "--name", RESTORE_CHECK_CONTAINER, "--label", RESTORE_CHECK_LABEL, "--network", "none",
        "--tmpfs", "/var/lib/postgresql/data", "-e", `POSTGRES_PASSWORD=${generatePassword()}`, "-e", `POSTGRES_DB=${RESTORE_CHECK_DATABASE}`, POSTGRES_IMAGE,
      ]);
      // TCP readiness (-h 127.0.0.1): the initdb-phase server listens on the socket only.
      await waitFor(async () => {
        try {
          await run("docker", ["exec", RESTORE_CHECK_CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", RESTORE_CHECK_DATABASE]);
          return true;
        } catch {
          return false;
        }
      }, "the restore-check Postgres");
      await run("docker", ["exec", "-i", RESTORE_CHECK_CONTAINER, "pg_restore", "--no-owner", "--no-privileges", "--exit-on-error", "-U", "postgres", "-d", RESTORE_CHECK_DATABASE], {
        stdinFile: dumpPath,
      });
      const tables = (await restoreCheckPsql(
        "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema IN ('app','drizzle') AND table_type = 'BASE TABLE' ORDER BY 1",
      )).trim().split("\n").filter((line) => line !== "");
      const tableRowCounts: Record<string, number> = {};
      if (tables.length > 0) {
        const union = tables.map((table) => {
          const [schema, name] = table.split(".") as [string, string];
          return `SELECT '${table}' || '|' || count(*) FROM ${quoteIdent(schema)}.${quoteIdent(name)}`;
        }).join(" UNION ALL ");
        for (const line of (await restoreCheckPsql(union)).trim().split("\n")) {
          const [table, n] = line.split("|") as [string, string];
          tableRowCounts[table] = Number(n);
        }
      }
      const [count, latest] = (await restoreCheckPsql("SELECT count(*) || '|' || coalesce(max(created_at)::text, '') FROM drizzle.__drizzle_migrations")).trim().split("|") as [string, string];
      mismatches.push(...compareWithManifest(manifest, { migrations: { count: Number(count), latestCreatedAt: latest === "" ? null : latest }, tableRowCounts }));
    } finally {
      await removeRestoreCheckContainer();
    }
  }

  const verification: RestoreVerification = {
    dumpFile: manifest.dumpFile,
    verifiedAt: new Date().toISOString(),
    restoreDatabase: RESTORE_CHECK_DATABASE,
    sha256Matched,
    mismatches,
    ok: mismatches.length === 0,
  };
  const verifyPath = join(DOGFOOD_BACKUP_DIR, `${baseName}.verify.json`);
  await rm(verifyPath, { force: true });
  await writeSecretFile(verifyPath, [JSON.stringify(verification, null, 2)]);
  if (!verification.ok) {
    logger.error("Dogfood restore-check FAILED", { dump: manifest.dumpFile, mismatches });
    throw new Error(`Restore-check failed for ${manifest.dumpFile}: ${mismatches.join("; ")}`);
  }
  logger.info("Dogfood restore-check passed", { dump: manifest.dumpFile, tables: Object.keys(manifest.tableRowCounts).length, migrations: manifest.migrations.count });
  return verification;
}

// ---------------------------------------------------------------- retention / status

async function listBackups(): Promise<BackupEntry[]> {
  if (!existsSync(DOGFOOD_BACKUP_DIR)) return [];
  const entries: BackupEntry[] = [];
  for (const file of await readdir(DOGFOOD_BACKUP_DIR)) {
    if (!file.endsWith(".dump")) continue;
    const baseName = file.slice(0, -".dump".length);
    const parsed = parseBackupBaseName(baseName);
    if (parsed === null) continue;
    let verified: boolean;
    try {
      verified = (JSON.parse(await readFile(join(DOGFOOD_BACKUP_DIR, `${baseName}.verify.json`), "utf8")) as RestoreVerification).ok;
    } catch {
      verified = false;
    }
    entries.push({ baseName, ...parsed, verified });
  }
  return entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function prune(apply: boolean): Promise<void> {
  const decision = decideRetention(await listBackups(), new Date());
  for (const { entry, why } of decision.keep) logger.info("keep", { backup: entry.baseName, why });
  for (const entry of decision.prune) {
    logger.info(apply ? "prune (deleting)" : "prune (dry-run)", { backup: entry.baseName });
    if (apply) {
      for (const suffix of [".dump", ".sha256", ".manifest.json", ".verify.json"]) await rm(join(DOGFOOD_BACKUP_DIR, `${entry.baseName}${suffix}`), { force: true });
    }
  }
  if (!apply && decision.prune.length > 0) logger.info("Dry-run only — re-run with --apply to delete", { count: decision.prune.length });
}

export async function status(): Promise<void> {
  const state = await containerState(DOGFOOD_CONTAINER);
  logger.info("Container", { name: DOGFOOD_CONTAINER, state: state ?? "absent" });
  if (state?.startsWith("running") === true) {
    const config = await loadAdminConfig();
    const identity = await readDatabaseIdentity(config.adminDatabaseUrl);
    const sql = postgres(config.adminDatabaseUrl, { max: 1, onnotice: () => undefined });
    try {
      logger.info("Database", { ...identity, appliedMigrations: await appliedMigrationCount(sql), journalMigrations: await journalMigrationCount() });
    } finally {
      await sql.end();
    }
  }
  const backups = await listBackups();
  logger.info("Backups", { dir: DOGFOOD_BACKUP_DIR, count: backups.length, newest: backups[0]?.baseName ?? null, newestVerified: backups.find((b) => b.verified)?.baseName ?? null });
}

// ---------------------------------------------------------------- identity import (Phase C)

const IDENTITY_DIR = join(DOGFOOD_BACKUP_DIR, "identity");

/** Read-only against `vostivo_manual`; writes one reviewable snapshot outside the repo. Never touches dogfood. */
export async function exportIdentity(subjectPrefix: string | undefined, expectedUserId: string | undefined): Promise<string> {
  if (subjectPrefix === undefined || !/^[0-9a-f]{8,36}$/.test(subjectPrefix.replace(/-/g, "")) || expectedUserId === undefined) {
    throw new Error("export-identity requires --subject-prefix=<at least 8 hex chars> and --expect-user-id=<uuid>.");
  }
  const sourceUrl = parseEnvFile(await readFile(join(REPOSITORY_ROOT, "apps", "api", ".env"), "utf8")).DATABASE_URL;
  if (sourceUrl === undefined) throw new Error("apps/api/.env has no DATABASE_URL.");
  assertIdentitySource(sourceUrl);

  const sql = postgres(sourceUrl, { max: 1, onnotice: () => undefined });
  let snapshot: IdentitySnapshot;
  try {
    snapshot = buildIdentitySnapshot(await readSourceIdentityRows(sql, subjectPrefix, expectedUserId), new Date());
  } finally {
    await sql.end();
  }
  const problems = validateIdentitySnapshot(snapshot);
  if (problems.length > 0) throw new IdentityImportCollisionError(problems);

  await prepareBackupDir();
  await mkdir(IDENTITY_DIR, { recursive: true, mode: 0o700 });
  await chmod(IDENTITY_DIR, 0o700);
  const path = join(IDENTITY_DIR, `identity-${snapshot.user.id}.json`);
  await rm(path, { force: true });
  await writeSecretFile(path, [JSON.stringify(snapshot, null, 2)]);
  logger.info("Identity snapshot written", { path, subject: maskSubject(snapshot.authIdentity.providerSubject), userId: snapshot.user.id, athleteProfileId: snapshot.athleteProfile.id, sha256: snapshot.sha256 });
  return path;
}

/** Dry-run unless `apply`. See `runIdentityImport` for the order of the safety steps. */
export async function importIdentity(snapshotPath: string | undefined, apply: boolean): Promise<IdentityImportOutcome> {
  if (snapshotPath === undefined) throw new Error("import-identity requires --snapshot=<path> (from export-identity).");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as IdentitySnapshot;
  const config = await loadAdminConfig();
  await assertDataEnvironment("dogfood", config.adminDatabaseUrl);

  const sql = postgres(config.adminDatabaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const outcome = await runIdentityImport({
      snapshot,
      apply,
      readState: () => readDogfoodIdentityState(sql, snapshot),
      assertNoRuntimeConnections: async () => {
        const connections = await countRoleConnections(sql, DOGFOOD_RUNTIME_ROLE);
        if (connections > 0) throw new IdentityImportCollisionError([`${connections} live ${DOGFOOD_RUNTIME_ROLE} connections — stop the dogfood API and worker first`]);
      },
      backupAndVerify: async () => {
        await verifyBackup(await createBackup("pre-import"));
      },
      applyTransaction: () => applyIdentityRows(sql, snapshot),
      verifyAfterCommit: () => verifyImportedIdentity(sql, snapshot),
    });
    logger.info("Identity import result", {
      outcome,
      mode: apply ? "apply" : "dry-run",
      subject: maskSubject(snapshot.authIdentity.providerSubject),
      userId: snapshot.user.id,
      authIdentityId: snapshot.authIdentity.id,
      athleteProfileId: snapshot.athleteProfile.id,
      rows: { users: 1, auth_identities: 1, athlete_profiles: 1 },
    });
    return outcome;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------- CLI

function flagValue(args: readonly string[], flag: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init-config":
      return initConfig(process.env.DOGFOOD_SUPABASE_URL);
    case "up":
      return up();
    case "bootstrap":
      return bootstrap();
    case "backup": {
      const reasonFlag = rest.find((arg) => arg.startsWith("--reason="))?.slice("--reason=".length) ?? "manual";
      if (!(BACKUP_REASONS as readonly string[]).includes(reasonFlag)) throw new Error(`--reason must be one of ${BACKUP_REASONS.join(", ")}`);
      const dump = await createBackup(reasonFlag as BackupReason);
      if (!rest.includes("--no-verify")) await verifyBackup(dump);
      return;
    }
    case "verify": {
      const target = rest[0] === undefined || rest[0] === "--latest" ? (await listBackups())[0]?.baseName : rest[0].replace(/^.*\//, "").replace(/\.dump$/, "");
      if (target === undefined) throw new Error("No dogfood backups found.");
      await verifyBackup(join(DOGFOOD_BACKUP_DIR, `${target}.dump`));
      return;
    }
    case "prune":
      return prune(rest.includes("--apply"));
    case "status":
      return status();
    case "export-identity":
      await exportIdentity(flagValue(rest, "--subject-prefix"), flagValue(rest, "--expect-user-id"));
      return;
    case "import-identity":
      await importIdentity(flagValue(rest, "--snapshot"), rest.includes("--apply"));
      return;
    default:
      throw new Error("Usage: pnpm dogfood <init-config|up|bootstrap|backup [--reason=manual|daily|pre-migration|pre-import] [--no-verify]|verify [--latest|<dump>]|prune [--apply]|status|export-identity --subject-prefix=<hex> --expect-user-id=<uuid>|import-identity --snapshot=<path> [--apply]>");
  }
}

if (process.env.VITEST === undefined) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    logger.error("dogfood command failed", { error: error instanceof Error ? error.message : error });
    process.exitCode = 1;
  });
}
