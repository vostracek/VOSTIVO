import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { RequestRejectedSyncResponse, type WorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import { UnresolvedSyncMonitor, type UnresolvedSyncNotice } from "../workout/unresolved-sync-notice";
import { createAthleteRuntime, type AthleteRuntime } from "./plan-runtime";

/**
 * CC-03: Today's unresolved-sync notice is wired to the REAL runtime graph
 * (repository summary + coordinator pass events + coordinator systemic
 * flag) — not only to fakes.
 */
const OWNER = "0190a000-0000-7000-8000-00000000000a";
const PRESCRIPTION: WorkoutPrescriptionV1 = { schemaVersion: 1, prescriptionId: "cc03-runtime", name: "CC03 Runtime", exercises: [] };

class ScriptedServer implements WorkoutSyncApiClient {
  refuse = true;
  syncCommands(_token: string, request: SyncWorkoutCommandsRequest): Promise<SyncWorkoutCommandsResponse> {
    if (this.refuse) return Promise.reject(new RequestRejectedSyncResponse(400));
    return Promise.resolve({ acknowledgements: request.commands.map((command) => ({ commandId: command.commandId, outcome: "APPLIED" as const })) });
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 50 && !condition(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe("AthleteRuntime unresolved sync ports (CC-03)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let server: ScriptedServer;

  function launch(): AthleteRuntime {
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    return createAthleteRuntime({
      ownerUserId: OWNER,
      database: { db, close: () => Promise.resolve(connection.close()) },
      authTokenProvider: { getAccessToken: () => Promise.resolve("synthetic-test-token") },
      apiBaseUrl: "http://api.invalid",
      syncPermitted: true,
      workoutSyncApiClient: server,
    });
  }

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-cc03-runtime-${createEntityId()}.db`;
    server = new ScriptedServer();
  });

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it("a refused command raises the notice after the sync pass, it survives a relaunch, and clears once the server accepts it", async () => {
    let runtime = launch();
    const notices: (UnresolvedSyncNotice | null)[] = [];
    let monitor = new UnresolvedSyncMonitor(runtime.unresolvedSyncPorts, (notice) => notices.push(notice));
    monitor.start();
    await until(() => notices.length === 1);
    expect(notices.at(-1)).toBeNull();

    await runtime.workoutApplicationService.startWorkoutSession(PRESCRIPTION);
    runtime.workoutSyncCoordinator.requestSync("mutation");
    await until(() => notices.at(-1) !== null);
    expect(notices.at(-1)?.message).toContain("saved on this device");

    // Relaunch while the server still refuses: the notice is shown from the persisted state.
    monitor.dispose();
    await runtime.dispose();
    runtime = launch();
    const relaunched: (UnresolvedSyncNotice | null)[] = [];
    monitor = new UnresolvedSyncMonitor(runtime.unresolvedSyncPorts, (notice) => relaunched.push(notice));
    monitor.start();
    await until(() => relaunched.length >= 1);
    expect(relaunched.at(-1)).not.toBeNull();

    // App resume: the foreground trigger re-probes; the server now accepts.
    server.refuse = false;
    runtime.workoutSyncCoordinator.requestSync("foreground");
    await until(() => relaunched.at(-1) === null);

    monitor.dispose();
    await runtime.dispose();
  });
});
