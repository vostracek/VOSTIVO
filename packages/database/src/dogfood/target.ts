import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DataEnvironmentMismatchError, DOGFOOD_DATABASE_NAME } from "../data-environment.js";

/**
 * Dogfood Environment V1 — the fixed identity of the dogfood instance.
 * Constants, never env-configurable: a misconfigured variable must not be
 * able to widen what dogfood tooling connects to, backs up or restores.
 * Must match infra/dogfood/docker-compose.yml.
 */
export const DOGFOOD_CONTAINER = "vostivo-dogfood-postgres";
export const DOGFOOD_HOST = "127.0.0.1";
export const DOGFOOD_PORT = 5433;
export const DOGFOOD_OWNER_ROLE = "vostivo_dogfood_owner";
export const DOGFOOD_RUNTIME_ROLE = "vostivo_dogfood_api";
export const DOGFOOD_API_HOST = "127.0.0.1";
export const DOGFOOD_API_PORT = 4100;

/** Ephemeral restore-check instance: own fixed container + database name, no volume, no published port. */
export const RESTORE_CHECK_CONTAINER = "vostivo-dogfood-restorecheck";
export const RESTORE_CHECK_DATABASE = "vostivo_dogfood_restorecheck";
export const POSTGRES_IMAGE = "postgres:17-alpine";

/** Secrets/config and backups live outside the repo and outside the Docker volume. */
export const DOGFOOD_CONFIG_DIR = join(homedir(), ".config", "vostivo", "dogfood");
export const DOGFOOD_BACKUP_DIR = join(homedir(), "VostivoBackups", "dogfood");

/** Every dogfood tool connects only to exactly this host/port/database as one of the two dogfood roles. */
export function assertDogfoodConnectionTarget(connectionString: string, expectedRole: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DataEnvironmentMismatchError("Dogfood connection string is not a valid URL.");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const problems: string[] = [];
  if (url.hostname !== DOGFOOD_HOST) problems.push(`host must be ${DOGFOOD_HOST}`);
  if (url.port !== String(DOGFOOD_PORT)) problems.push(`port must be ${DOGFOOD_PORT}`);
  if (databaseName !== DOGFOOD_DATABASE_NAME) problems.push(`database must be ${DOGFOOD_DATABASE_NAME}`);
  if (decodeURIComponent(url.username) !== expectedRole) problems.push(`role must be ${expectedRole}`);
  if (problems.length > 0) {
    throw new DataEnvironmentMismatchError(`Refusing dogfood connection target: ${problems.join(", ")}.`);
  }
}

/** Backups and config must never land inside the repository (or any git working tree we know of). */
export function assertOutsideRepository(path: string, repositoryRoot: string): void {
  const rel = relative(resolve(repositoryRoot), resolve(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new DataEnvironmentMismatchError(`Refusing to use ${path}: it is inside the repository.`);
  }
}
