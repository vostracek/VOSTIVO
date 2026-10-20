import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { AvailableTimePreviewResponseV1, StartWorkoutSessionCommandV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { AdjustedWorkoutStartService } from "../workout/adjusted-workout-start";
import { WorkoutRepository } from "../workout/workout-repository";
import { AvailableTimeFlowController, type AvailableTimeFlowPorts } from "./available-time-controller";
import { BENCH_SETS, WORKOUT_ID, adjustPreview, workoutPreview } from "./testing/fixtures";

/**
 * Available-Time Slice D, the critical boundary (task §13/§25.23/§25.24):
 * the preview succeeds ONLINE, then the API/network becomes unavailable,
 * then the athlete taps Start adjusted workout — and the adjusted workout
 * still starts, locally and durably, with ZERO network calls and without
 * waiting on sync. Real WorkoutRepository SQL on a real SQLite engine, the
 * real AdjustedWorkoutStartService, the real flow controller.
 */
describe("Available-Time — offline after preview (real local START)", () => {
  let path: string;
  let connection: TestDatabaseConnection;

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-available-time-offline-${createEntityId()}.db`;
    connection = openTestLocalDatabase(path);
  });

  afterEach(() => {
    connection.close();
    rmSync(path, { force: true });
  });

  it("24/23/22: a successful preview followed by an outage still starts the adjusted workout locally, at once", async () => {
    const db = connection.db;
    const repository = new WorkoutRepository(() => Promise.resolve(db));

    // The real coordinator's request is fire-and-forget; here its sync attempt can never
    // finish (no network) — the start must not depend on it.
    let syncRequestsAfterCommit = 0;
    const neverEndingSync = { requestSync: () => {
      const committed = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM sync_outbox`)!.n;
      if (committed === 1) syncRequestsAfterCommit += 1;
      void new Promise(() => {}); // a sync that never completes
    } };
    const adjustedStart = new AdjustedWorkoutStartService(repository, neverEndingSync);

    let online = true;
    let apiCallsWhileOffline = 0;
    const api = <T,>(value: T): Promise<T> => {
      if (online) return Promise.resolve(value);
      apiCallsWhileOffline += 1;
      return Promise.reject(new TypeError("Network request failed"));
    };
    const ports: AvailableTimeFlowPorts = {
      previewAvailableTime: (): Promise<AvailableTimePreviewResponseV1> => api(adjustPreview(5)),
      getWorkoutPreview: (): Promise<WorkoutPreviewV1> => api(workoutPreview()),
      startWorkout: (preview) => repository.startWorkoutSession(preview.prescription),
      startAdjustedWorkout: (input) => adjustedStart.startAdjustedWorkout(input),
      requestSync: () => neverEndingSync.requestSync(),
    };
    let navigations = 0;
    const controller = new AvailableTimeFlowController(WORKOUT_ID, ports, {
      onStateChange: () => {},
      navigateToActiveWorkout: () => (navigations += 1),
      dismiss: () => {},
      refreshToday: () => {},
    });

    controller.selectPreset(30);
    controller.requestPreview();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().kind).toBe("ADJUST_SESSION");

    online = false; // the network drops after a successful preview
    await controller.startAdjusted();

    expect(navigations).toBe(1);
    expect(apiCallsWhileOffline).toBe(0); // no request of any kind before (or for) the adjusted START
    expect(syncRequestsAfterCommit).toBe(1); // sync was requested only after the local commit, and not awaited

    const session = await repository.getActiveWorkoutSession();
    expect(session?.availableTimeApplication).toMatchObject({ plannedWorkoutId: WORKOUT_ID, availableMinutes: 5 });
    expect(session?.prescription.exercises.map((e) => e.sets.map((s) => s.prescriptionSetId))).toEqual([BENCH_SETS.slice(0, 2)]);
    const pending = await repository.getPendingCommands(10);
    expect(pending).toHaveLength(1);
    expect((pending[0]!.payload as StartWorkoutSessionCommandV1).availableTimeApplication).toEqual(session?.availableTimeApplication);
  });
});
