import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { WorkoutRepository } from "./workout-repository";
import { SyncEngine } from "./sync-engine";
import { FetchWorkoutSyncApiClient } from "./workout-sync-api-client";
import type { AuthTokenProvider } from "./auth-token-provider";

/**
 * CC-01 Strength Regression Baseline — the known HTTP 400 blocking defect
 * (D-SYNC-1), on the real SyncEngine, the real FetchWorkoutSyncApiClient and
 * the real repository SQL. Only `fetch` is faked, and it reproduces the real
 * server contract proven in `workout-sync-batch-validation.cc01-baseline.test.ts`:
 * one invalid command fails the WHOLE batch with 400.
 *
 * The `it` tests describe guarantees that must survive the repair. The two
 * D-SYNC-1 tests were `it.fails` until CC-03 repaired the defect (request-
 * level 400 -> single-command isolation -> BLOCKED, see
 * `sync-outbox-recovery.test.ts`); they now pass as plain `it`.
 */
const OWNER = "0190a000-0000-7000-8000-00000000000a";
const POISON_COMMAND_ID = "0190a000-0000-7000-8000-0000000000ff";

const PRESCRIPTION: WorkoutPrescriptionV1 = { schemaVersion: 1, prescriptionId: "cc01-sync", name: "CC01 Sync", exercises: [] };

const authTokenProvider: AuthTokenProvider = { getAccessToken: () => Promise.resolve("synthetic-test-token") } as AuthTokenProvider;

describe("CC-01 sync HTTP 400 behavior", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;
  let engine: SyncEngine;
  let delivered: string[];

  function insertPoison(createdAt: string): void {
    const payload = JSON.stringify({ commandId: POISON_COMMAND_ID, type: "NOT_A_KNOWN_COMMAND", schemaVersion: 1, createdAt });
    connection.db.run(
      sql`INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, status, created_at, updated_at)
          VALUES (${POISON_COMMAND_ID}, 'NOT_A_KNOWN_COMMAND', 1, ${payload}, 'PENDING', ${createdAt}, ${createdAt})`,
    );
  }

  function outboxContents(): { commandId: string; payload: string }[] {
    return connection.db
      .all<{ command_id: string; payload_json: string }>(sql`SELECT command_id, payload_json FROM sync_outbox ORDER BY created_at ASC, rowid ASC`)
      .map((row) => ({ commandId: row.command_id, payload: row.payload_json }));
  }

  function statusOf(commandId: string): string | undefined {
    return connection.db.get<{ status: string }>(sql`SELECT status FROM sync_outbox WHERE command_id = ${commandId}`)?.status;
  }

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-cc01-sync-${createEntityId()}.db`;
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
    engine = new SyncEngine(OWNER, repository, authTokenProvider, new FetchWorkoutSyncApiClient("http://sync.invalid"));
    delivered = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as SyncWorkoutCommandsRequest;
        if (request.commands.some((command) => command.commandId === POISON_COMMAND_ID)) {
          return Promise.resolve(new Response(JSON.stringify({ statusCode: 400 }), { status: 400 }));
        }
        delivered.push(...request.commands.map((command) => command.commandId));
        const body: SyncWorkoutCommandsResponse = {
          acknowledgements: request.commands.map((command) => ({ commandId: command.commandId, outcome: "APPLIED" })),
        };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    connection.close();
    rmSync(path, { force: true });
  });

  it("CC01-SYNC-001: without an invalid command the same path delivers and marks everything SYNCED", async () => {
    await repository.startWorkoutSession(PRESCRIPTION);

    const result = await engine.syncPendingCommands();

    expect(result).toMatchObject({ attempted: 1, synced: 1, retried: 0 });
    expect(await repository.getPendingCommands(25)).toEqual([]);
  });

  it("CC01-SYNC-002: a 400 never loses data: every command and its payload stay in the outbox", async () => {
    insertPoison("2026-01-01T00:00:00.000Z");
    await repository.startWorkoutSession(PRESCRIPTION);
    const before = outboxContents();

    // CC-03: the 400 is no longer rethrown as an unexpected error — it is
    // isolated. The guarantee is unchanged: no command, id or payload is
    // deleted or rewritten, and local workout reality is untouched.
    await engine.syncPendingCommands();

    expect(outboxContents()).toEqual(before);
    expect(statusOf(POISON_COMMAND_ID)).toBe("BLOCKED");
    expect(await repository.getActiveWorkoutSession()).toBeDefined();
  });

  it("CC01-SYNC-003: pending commands are read oldest first and limited to the batch size", async () => {
    insertPoison("2026-01-01T00:00:00.000Z");
    await repository.startWorkoutSession(PRESCRIPTION);

    const pending = await repository.getPendingCommands(1);

    expect(pending.map((record) => record.commandId)).toEqual([POISON_COMMAND_ID]);
  });

  // D-SYNC-1 (repaired by CC-03): the client used to treat 400 as retryable
  // for the whole batch; oldest-first ordering re-selected the same invalid
  // command on every pass, so newer valid commands never left the device.
  it("CC01-KNOWN-DEFECT D-SYNC-1 (desired): one invalid command must not stop a valid newer command from reaching the server", async () => {
    insertPoison("2026-01-01T00:00:00.000Z");
    const started = await repository.startWorkoutSession(PRESCRIPTION);
    expect(started.status).toBe("STARTED");
    const [, valid] = await repository.getPendingCommands(25);

    for (let pass = 0; pass < 5; pass += 1) {
      await engine.syncPendingCommands().catch(() => undefined);
    }

    expect(delivered).toContain(valid!.commandId);
    expect(statusOf(valid!.commandId)).toBe("SYNCED");
  });

  it("CC01-KNOWN-DEFECT D-SYNC-1 (desired): an invalid command must leave the retry loop", async () => {
    insertPoison("2026-01-01T00:00:00.000Z");

    await engine.syncPendingCommands().catch(() => undefined);

    expect(statusOf(POISON_COMMAND_ID)).not.toBe("RETRY");
  });

  it("D-SYNC-1 repair: a refused command is visible as unresolved sync state, never silently dropped", async () => {
    insertPoison("2026-01-01T00:00:00.000Z");

    await engine.syncPendingCommands();

    expect(await repository.getUnresolvedSyncSummary()).toEqual({ blocked: 1, waitingOnBlocked: 0, rejected: 0, conflicted: 0 });
    expect(outboxContents().map((row) => row.commandId)).toContain(POISON_COMMAND_ID);
  });
});
