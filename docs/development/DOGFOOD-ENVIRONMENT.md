# Dogfood Environment V1

The dogfood environment holds Lukáš's **real** training data. It is a
separate PostgreSQL instance, never a database inside the dev/acceptance
stack, and is protected by two independent layers.

## Topology

| | Dev / acceptance (unchanged) | Dogfood |
|---|---|---|
| Compose file | `docker-compose.yml` (project `vostivo`) | `infra/dogfood/docker-compose.yml` (project `vostivo-dogfood`) |
| Container | `vostivo-postgres-1` | `vostivo-dogfood-postgres` |
| Volume | `vostivo_vostivo_postgres_data` | `vostivo_dogfood_pgdata` |
| Host port | `5432` | `127.0.0.1:5433` (loopback only) |
| Databases | `vostivo_dev`, `vostivo_manual` | `vostivo_dogfood` only |
| Owner / migrator | `vostivo` | `vostivo_dogfood_owner` (random password) |
| Runtime role | `vostivo_api` | `vostivo_dogfood_api` (random password, DML only) |
| API / worker | `0.0.0.0:4000` (default `HOST`) | `127.0.0.1:4100` (`HOST=127.0.0.1`) / separate worker process |

## Layer 1 — infrastructure

Separate container, volume and cluster: the dev/test roles (`vostivo`,
`vostivo_api`) do not exist there, and the owner/runtime passwords are
generated randomly into `~/.config/vostivo/dogfood/` (dir `700`, files
`600`, never in git, never printed). The runtime role has `NOSUPERUSER
NOCREATEDB NOCREATEROLE`, no CREATE on any schema, and is the only
non-owner role with CONNECT on `vostivo_dogfood`.

## Layer 2 — data-environment guards

`packages/database/src/data-environment.ts`:

- **Marker**: `COMMENT ON DATABASE vostivo_dogfood IS 'vostivo-data-env:dogfood'`.
- **API + worker startup** (`assertDataEnvironment`): `VOSTIVO_DATA_ENV=dogfood`
  requires database `vostivo_dogfood` **with** the marker; any other value
  (or unset) refuses a database named `vostivo_dogfood` or carrying the
  marker. `LOCAL_JWKS_PATH` is a config error together with `dogfood`, and so
  is any `HOST` other than `127.0.0.1`/`::1` — the dogfood API is never
  reachable from the LAN (a later Tailscale Serve proxies the localhost endpoint).
- **Integration tests** (`vitest.integration.setup.ts` in `apps/api`,
  `apps/worker`, `packages/progression-application`): refuse
  `VOSTIVO_DATA_ENV=dogfood` and any `DATABASE_URL` / `MIGRATION_DATABASE_URL`
  / `MANUAL_DATABASE_URL` naming `vostivo_dogfood`, before any test connects.
- **Dev tooling** (`db:migrate`, `db:bootstrap-roles`, `db:bootstrap-pgboss`,
  `db:seed:dev-plan`): the same URL check plus the connected database's
  identity. `db:manual:reset` already only accepts `vostivo_manual`.
- **Dogfood tooling** connects only to `127.0.0.1:5433/vostivo_dogfood` as
  the expected dogfood role, and there is **no reset/drop command**.

## Commands

```bash
DOGFOOD_SUPABASE_URL=https://<ref>.supabase.co pnpm dogfood init-config   # once; never overwrites
pnpm dogfood up            # start the instance (compose --env-file ~/.config/vostivo/dogfood/compose.env)
pnpm dogfood bootstrap     # idempotent: marker, runtime role, migrations, pg-boss, grants
pnpm dogfood backup        # pg_dump -Fc + sha256 + manifest, then automatic restore-check
pnpm dogfood verify [--latest|<name>]
pnpm dogfood prune [--apply]   # dry-run by default
pnpm dogfood status
pnpm build && pnpm dogfood:api      # API on :4100 with runtime.env
pnpm dogfood:worker
```

Never run `docker compose ... down -v` on the dogfood project — the volume is the data.

## Backups

- `~/VostivoBackups/dogfood/` (outside repo and Docker volume; dir `700`, files `600`).
- `vostivo_dogfood-<UTC>-<reason>.dump` (`pg_dump -Fc`), `.sha256`
  (`sha256sum -c` compatible), `.manifest.json` (row count per `app`/`drizzle`
  table, migration count/latest, marker, server version — no row data, no
  credentials), `.verify.json` (restore-check result).
- Counts and dump come from the **same snapshot** (`pg_export_snapshot()` +
  `pg_dump --snapshot`).
- Reasons: `manual`, `daily`, `pre-migration`, `pre-import` (reserved for the
  future plan-import tool).
- **Migration gate** (`dogfood/migration-gate.ts`): with pending migrations on
  a schema that already has applied migrations, `bootstrap` writes a
  `pre-migration` backup and runs its restore-check first; any failure stops
  the bootstrap before a single migration runs. A brand-new empty schema
  migrates without a backup; nothing pending writes no backup.
- **Restore-check**: throwaway container `vostivo-dogfood-restorecheck`
  (label-checked, `--network none`, tmpfs data dir, no volume, no published
  port), database `vostivo_dogfood_restorecheck`, `pg_restore --no-owner
  --no-privileges --exit-on-error`, then an exact comparison with the
  manifest. Never restores into the dogfood instance.
- **Retention**: keep everything < 14 days; 14 days – 8 weeks the newest per
  ISO week; `pre-migration`/`pre-import` ≥ 30 days; always the newest and the
  newest verified backup. `prune` is dry-run unless `--apply`.

## Phase C/D decisions (2026-10-28)

- **Supabase**: Dogfood Alpha uses the current DEV Supabase project (keeps the
  existing Supabase subject and internal userId). Production/staging Supabase
  is separated before the external beta.
- **IDs**: ADR-0006 stays unchanged — every new domain entity gets a UUIDv7 via
  `createEntityId()`; UUIDv5 was rejected.

## Identity import (Phase C)

Moves exactly one real identity from `vostivo_manual` into the empty dogfood
database with the same UUIDs: one row each in `users`, `auth_identities` and
`athlete_profiles`. No training data. Same subject + same `users.id` means the
device binding never hits `BINDING_CONFLICT`.

```bash
pnpm dogfood:export-identity --subject-prefix=<hex> --expect-user-id=<uuid>   # read-only, writes ~/VostivoBackups/dogfood/identity/
pnpm dogfood:import-identity --snapshot=<path>            # dry-run (default), writes nothing
pnpm dogfood:import-identity --snapshot=<path> --apply
```

`--apply`: validate snapshot -> classify (`IMPORTABLE` / `ALREADY_IMPORTED` /
`COLLISION`) -> refuse live `vostivo_dogfood_api` connections -> `pre-import`
backup + restore-check -> one transaction (table locks, re-classify, insert,
exact re-read, rollback on any difference) -> verification after commit.
A repeated run is an `ALREADY_IMPORTED` no-op. There is no overwrite or delete path.

Never authenticate against the dogfood API before the import: `resolveOrCreateIdentity`
would auto-provision the subject under a new UUID, which is a `COLLISION`. The
dogfood client is only a clean iPhone install; acceptance AVDs never connect to
the dogfood API (local DBs are keyed by `userId`, so their acceptance data and
outbox would reach dogfood).

## Future: plan import (Phase D, not implemented)

`tools/dogfood` import: dry-run by default, explicit `--apply`; idempotent via
a stable logical import key per imported object and a persistent dogfood-only
mapping `logical_key -> UUIDv7` (generated once with `createEntityId()`,
reused on later runs) — preferably its own tooling schema/table inside
`vostivo_dogfood` with a UNIQUE logical key and minimal privileges, included
in backup/restore, never read by the product runtime; no UUIDv5 in domain
tables. Never deletes completed workouts/history/claims/sessions, program
changes only take effect in the future, and an automatic `pre-import` backup
+ restore-check runs before `--apply`.
