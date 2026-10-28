import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse, WorkoutCommandV1 } from "@vostivo/contracts";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase } from "../local-database/testing/node-sqlite-database";
import { LEGACY_DATABASE_NAME, athleteDatabaseName } from "../local-database/athlete-database";
import type { AthleteDatabaseHandle } from "../local-database/athlete-database-handle";
import type { AthleteRuntime } from "../plan/plan-runtime";
import { RuntimeOwnerMismatchError, SyncNotPermittedError } from "../workout/auth-token-provider";
import { TransientSyncFailure, UnauthorizedSyncResponse, type WorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import { SUPABASE_PROVIDER, type AuthSession } from "./auth-session";
import { createAthleteRuntimeOpener } from "./athlete-runtime-opener";
import { IdentityBindingStore } from "./identity-binding-store";
import { IdentityGateController, type IdentityGateState } from "./identity-gate-controller";
import { resolveIdentity } from "./identity-resolution";
import { readUnverifiedJwtSubject } from "./jwt-subject";
import { fetchVerifiedMe, type VerifiedMeOutcome } from "./verified-me-client";
import { ControllableSessionSource } from "./testing/controllable-session-source";
import { devToken, InMemorySecureValueStore } from "./testing/fakes";

/**
 * Auth & Local Athlete Boundary V1 Slice B — cross-athlete isolation through
 * the REAL IdentityGate state machine, the REAL runtime composition
 * (`createAthleteRuntimeOpener` -> `createAthleteRuntime`), the REAL
 * WorkoutRepository SQL and local migrations on REAL per-owner SQLite files
 * (named exactly like the app names them), and the REAL SyncEngine /
 * owner-bound token provider. Only SQLCipher, `fetch` and the server are
 * replaced: the fake server authenticates by token subject and applies the
 * same whole-batch `ownerUserId` guard as the real API.
 */
const A = { userId: "0190a000-0000-7000-8000-00000000000a", athleteProfileId: "0190a000-0000-7000-8000-0000000000aa" };
const B = { userId: "0190a000-0000-7000-8000-00000000000b", athleteProfileId: "0190a000-0000-7000-8000-0000000000bb" };
const USERS_BY_SUBJECT: Record<string, typeof A> = { "sub-a": A, "sub-b": B };
/** The bounded `/me` deadline used when the backend hangs (the app uses `VERIFIED_ME_TIMEOUT_MS`). */
const HANGING_ME_TIMEOUT_MS = 20;

function session(subject: "sub-a" | "sub-b", nonce = "1"): AuthSession {
  return { provider: SUPABASE_PROVIDER, providerSubject: subject, accessToken: devToken(subject, nonce) };
}

const UNPLANNED: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "isolation-unplanned",
  name: "Ad-hoc Push",
  exercises: [
    {
      prescriptionExerciseId: "ex-bench",
      exerciseRef: "bench-press",
      displayName: "Bench Press",
      order: 0,
      sets: [
        { prescriptionSetId: "set-1", order: 0, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: 90, setType: "WORKING" },
        { prescriptionSetId: "set-2", order: 1, targetReps: { kind: "EXACT", reps: 10 }, targetLoad: null, restSeconds: 90, setType: "WORKING" },
      ],
    },
  ],
};

/** The server as the sync endpoint sees it: actor = token subject; whole-batch 409 on an ownerUserId mismatch; owner-scoped receipts. */
class FakeServer implements WorkoutSyncApiClient {
  online = true;
  /** Access tokens the auth server no longer accepts (revoked / expired session) — 401 on sync AND on `/me`. */
  readonly revokedTokens = new Set<string>();
  readonly batches: { actorUserId: string; ownerUserId: string; commandIds: string[] }[] = [];
  readonly sessionOwners = new Map<string, string>();
  readonly receipts = new Set<string>();

  syncCommands(accessToken: string, request: SyncWorkoutCommandsRequest): Promise<SyncWorkoutCommandsResponse> {
    if (!this.online) return Promise.reject(new TransientSyncFailure("offline"));
    if (this.revokedTokens.has(accessToken)) return Promise.reject(new UnauthorizedSyncResponse());
    const actor = USERS_BY_SUBJECT[readUnverifiedJwtSubject(accessToken) ?? ""];
    if (actor === undefined) return Promise.reject(new Error("401"));
    this.batches.push({ actorUserId: actor.userId, ownerUserId: request.ownerUserId, commandIds: request.commands.map((c) => c.commandId) });
    if (request.ownerUserId !== actor.userId) return Promise.reject(new RuntimeOwnerMismatchError());
    return Promise.resolve({ acknowledgements: request.commands.map((command) => ({ commandId: command.commandId, outcome: this.apply(actor.userId, command) })) });
  }

  private apply(actorUserId: string, command: WorkoutCommandV1): "APPLIED" | "DUPLICATE" {
    const receipt = `${actorUserId}:${command.commandId}`;
    if (this.receipts.has(receipt)) return "DUPLICATE";
    this.receipts.add(receipt);
    if (command.type === "START_WORKOUT_SESSION_V1") this.sessionOwners.set(command.workoutSessionId, actorUserId);
    return "APPLIED";
  }
}

/** One "device": its files directory, SecureStore and the server stay; app processes come and go. */
class Device {
  readonly directory = `${tmpdir()}/vostivo-isolation-${createEntityId()}`;
  readonly secureStore = new InMemorySecureValueStore();
  readonly server = new FakeServer();
  /** `/me` reachability (independent of the sync endpoint). */
  meOnline = true;
  /** The API accepts `/me` and never answers — served by the REAL bounded `/me` client. */
  meHangs = false;
  /** Server-side subject -> user mapping changes (a remapped subject is a binding conflict on the device). */
  readonly meRemap = new Map<string, typeof A>();
  readonly openedFiles: string[] = [];
  readonly openHandles = new Set<string>();

  constructor() {
    mkdirSync(this.directory, { recursive: true });
  }

  openDatabase = (userId: string): Promise<{ kind: "OPENED"; handle: AthleteDatabaseHandle; databaseName: string }> => {
    const databaseName = athleteDatabaseName(userId);
    if (this.openHandles.size > 0) throw new Error(`another owner's database is still open: ${[...this.openHandles].join(", ")}`);
    const connection = openTestLocalDatabase(`${this.directory}/${databaseName}`);
    this.openedFiles.push(databaseName);
    this.openHandles.add(databaseName);
    return Promise.resolve({
      kind: "OPENED",
      databaseName,
      handle: {
        db: connection.db,
        close: () => {
          connection.close();
          this.openHandles.delete(databaseName);
          return Promise.resolve();
        },
      },
    });
  };

  /** A fresh app process (cold start) with the given session. */
  launch(initial: AuthSession | null): AppProcess {
    return new AppProcess(this, initial);
  }

  /** Raw read of one owner's file — evidence only, never app code. */
  outboxRows(userId: string): { command_id: string; status: string; attempt_count: number; command_type: string }[] {
    const connection = openTestLocalDatabase(`${this.directory}/${athleteDatabaseName(userId)}`);
    try {
      return connection.db.all(sql`SELECT command_id, status, attempt_count, command_type FROM sync_outbox ORDER BY created_at ASC`);
    } finally {
      connection.close();
    }
  }

  destroy(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

class AppProcess {
  readonly source: ControllableSessionSource;
  private readonly networkListeners = new Set<(isConnected: boolean) => void>();
  readonly controller: IdentityGateController<AthleteRuntime>;
  state: IdentityGateState<AthleteRuntime> = { status: "BOOTING" };

  constructor(
    private readonly device: Device,
    initial: AuthSession | null,
  ) {
    this.source = new ControllableSessionSource(initial);
    const bindings = new IdentityBindingStore(device.secureStore);
    const fetchMe = (accessToken: string): Promise<VerifiedMeOutcome> => {
      if (device.meHangs) return fetchVerifiedMe("http://api.invalid", accessToken, () => new Promise(() => {}), HANGING_ME_TIMEOUT_MS);
      if (!device.meOnline) return Promise.resolve({ kind: "UNREACHABLE" });
      if (device.server.revokedTokens.has(accessToken)) return Promise.resolve({ kind: "UNAUTHORIZED" });
      const subject = readUnverifiedJwtSubject(accessToken) ?? "";
      const user = device.meRemap.get(subject) ?? USERS_BY_SUBJECT[subject];
      return Promise.resolve(user === undefined ? { kind: "UNAUTHORIZED" } : { kind: "VERIFIED", ...user });
    };
    this.controller = new IdentityGateController<AthleteRuntime>({
      sessionSource: this.source,
      resolveIdentity: (current) => resolveIdentity(current, { fetchMe, bindings, now: () => new Date() }),
      openRuntime: createAthleteRuntimeOpener({
        sessionSource: this.source,
        apiBaseUrl: "http://api.invalid",
        openDatabase: device.openDatabase,
        workoutSyncApiClient: device.server,
        onSessionInvalid: () => void this.controller.reevaluate(),
      }),
      onStateChange: (state) => {
        this.state = state;
      },
      connectivity: {
        subscribe: (listener) => {
          this.networkListeners.add(listener);
          return () => this.networkListeners.delete(listener);
        },
      },
    });
    this.controller.start();
  }

  async settle(): Promise<void> {
    await this.controller.reevaluate();
  }

  /** The device's connectivity changes (expo-network in the app). */
  async network(isConnected: boolean): Promise<void> {
    for (const listener of [...this.networkListeners]) listener(isConnected);
    await this.settle();
  }

  async switchTo(next: AuthSession | null): Promise<void> {
    this.source.set(next);
    await this.settle();
  }

  get runtime(): AthleteRuntime {
    if (this.state.status !== "READY") throw new Error(`gate is ${this.state.status}, not READY`);
    return this.state.runtime;
  }

  /** Process death: nothing is awaited or cleaned up gracefully except releasing the file handle the OS would release. */
  async kill(): Promise<void> {
    await this.controller.stop();
  }
}

async function startAndLogFirstSet(runtime: AthleteRuntime, reps = 10, amountMilli = 60000): Promise<string> {
  const started = await runtime.workoutApplicationService.startWorkoutSession(UNPLANNED);
  if (started.status !== "STARTED") throw new Error(started.status);
  const sessionId = started.session.id;
  await runtime.workoutApplicationService.completeSet(
    {
      workoutSessionId: sessionId,
      prescriptionExerciseId: "ex-bench",
      exerciseRef: "bench-press",
      exerciseDisplayName: "Bench Press",
      exerciseOrder: 0,
      prescriptionSetId: "set-1",
      setOrder: 0,
      actualReps: reps,
      actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis: "TOTAL" },
      setType: "WORKING",
    },
    90,
  );
  await runtime.workoutApplicationService.saveSetDraft({ workoutSessionId: sessionId, prescriptionExerciseId: "ex-bench", prescriptionSetId: "set-2", draftReps: 8, draftLoad: { kind: "EXTERNAL_WEIGHT", amountMilli, unit: "KG", basis: "TOTAL" } });
  return sessionId;
}

describe("Auth & Local Athlete Boundary V1 Slice B — cross-athlete local isolation (real gate + runtime + SQLite)", () => {
  let device: Device;

  beforeEach(() => {
    device = new Device();
  });

  afterEach(() => {
    device.destroy();
  });

  it("ISO-11/12/15 + AUTH-LOCAL-001/005: A's ACTIVE workout (sets, draft, rest timer) is invisible to B and fully restored when A returns", async () => {
    device.server.online = false; // keep A's commands pending
    const app = device.launch(session("sub-a"));
    await app.settle();
    const aSessionId = await startAndLogFirstSet(app.runtime);
    const aBefore = await app.runtime.workoutApplicationService.getActiveWorkoutSession();

    await app.switchTo(session("sub-b"));
    expect(app.runtime.ownerUserId).toBe(B.userId);
    expect(await app.runtime.workoutApplicationService.getActiveWorkoutSession()).toBeUndefined();
    expect(await app.runtime.planApplicationService.getActiveWorkoutSession()).toBeUndefined();

    await app.switchTo(session("sub-a"));
    const aAfter = await app.runtime.workoutApplicationService.getActiveWorkoutSession();
    expect(aAfter?.id).toBe(aSessionId);
    expect(aAfter).toEqual(aBefore);
    expect(aAfter?.exercises[0]?.sets).toHaveLength(1);
    expect(aAfter?.drafts).toEqual([expect.objectContaining({ prescriptionSetId: "set-2", draftReps: 8 })]);
    expect(aAfter?.restTimer).toMatchObject({ durationSeconds: 90 });
  });

  it("ISO-13/14 / AUTH-LOCAL-012: A's PREV (Bench 60 x 10) never reaches B and comes back for A — physical isolation, no name filtering", async () => {
    const app = device.launch(session("sub-a"));
    await app.settle();
    const first = await startAndLogFirstSet(app.runtime, 10, 60000);
    await app.runtime.workoutApplicationService.finishWorkoutSession(first);
    const aSecond = await app.runtime.workoutApplicationService.startWorkoutSession(UNPLANNED);
    if (aSecond.status !== "STARTED") throw new Error(aSecond.status);
    expect(await app.runtime.workoutApplicationService.getPreviousExercisePerformance("bench-press", aSecond.session.id)).toEqual([
      { order: 0, actualReps: 10, actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" } },
    ]);

    await app.switchTo(session("sub-b"));
    const bStart = await app.runtime.workoutApplicationService.startWorkoutSession(UNPLANNED);
    expect(bStart.status).toBe("STARTED"); // B's own independent workout (one ACTIVE per owner DB)
    if (bStart.status !== "STARTED") return;
    expect(await app.runtime.workoutApplicationService.getPreviousExercisePerformance("bench-press", bStart.session.id)).toBeUndefined();

    await app.switchTo(session("sub-a"));
    expect((await app.runtime.workoutApplicationService.getActiveWorkoutSession())?.id).toBe(aSecond.session.id);
    expect(await app.runtime.workoutApplicationService.getPreviousExercisePerformance("bench-press", aSecond.session.id)).toHaveLength(1);
  });

  it("ISO-16/19/20 + AUTH-LOCAL-009/011: one file per owner, opened one at a time; the legacy vostivo.db is never opened; switching deletes nothing", async () => {
    const app = device.launch(session("sub-a"));
    await app.settle();
    await startAndLogFirstSet(app.runtime);
    await app.switchTo(session("sub-b"));
    await startAndLogFirstSet(app.runtime);
    await app.switchTo(session("sub-a"));

    expect(device.openedFiles).toEqual([athleteDatabaseName(A.userId), athleteDatabaseName(B.userId), athleteDatabaseName(A.userId)]);
    expect(device.openedFiles).not.toContain(LEGACY_DATABASE_NAME);
    expect(readdirSync(device.directory).sort()).toEqual([athleteDatabaseName(A.userId), athleteDatabaseName(B.userId)].sort());
    expect(device.outboxRows(B.userId).length).toBeGreaterThan(0);
    expect(device.outboxRows(A.userId).length).toBeGreaterThan(0);
  });

  it("SYNC-21/22 + AUTH-LOCAL-002: A syncs only as A with ownerUserId=A; B syncs only B's commands as B", async () => {
    const app = device.launch(session("sub-a"));
    await app.settle();
    await startAndLogFirstSet(app.runtime);
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();

    await app.switchTo(session("sub-b"));
    await startAndLogFirstSet(app.runtime);
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();

    const aCommands = device.outboxRows(A.userId).map((row) => row.command_id);
    const bCommands = device.outboxRows(B.userId).map((row) => row.command_id);
    expect(device.server.batches).toEqual([
      { actorUserId: A.userId, ownerUserId: A.userId, commandIds: aCommands },
      { actorUserId: B.userId, ownerUserId: B.userId, commandIds: bCommands },
    ]);
  });

  it("SYNC-23/24: A's runtime asked to sync while the session is already B's -> no network call, A's outbox untouched (no SYNCING, no attempt)", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a"));
    await app.settle();
    await startAndLogFirstSet(app.runtime);
    const runtimeA = app.runtime;
    await runtimeA.workoutApplicationService.syncPendingWorkoutCommands(); // offline -> RETRY
    const before = device.outboxRows(A.userId);
    device.server.online = true;

    // The session flips to B; A's runtime is still alive for this instant (before the gate's transition runs).
    app.source.set(session("sub-b"));
    await expect(runtimeA.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toBeInstanceOf(RuntimeOwnerMismatchError);

    expect(device.server.batches).toEqual([]);
    await app.settle();
    expect(device.outboxRows(A.userId)).toEqual(before);
  });

  it("RCPT-005b CLIENT SIDE (31-40): A's unsynced UNPLANNED START (X, session S) never reaches the server under B; back as A it syncs and S is A's; nothing lost", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a"));
    await app.settle();
    const sessionS = await startAndLogFirstSet(app.runtime);
    const aPending = device.outboxRows(A.userId);
    const commandX = aPending.find((row) => row.command_type === "START_WORKOUT_SESSION_V1")!.command_id;
    device.server.online = true;

    await app.switchTo(session("sub-b"));
    // 33: B's runtime physically cannot read A's outbox.
    expect(device.outboxRows(B.userId)).toEqual([]);
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    app.runtime.workoutSyncCoordinator.requestSync("launch");
    await app.settle();
    // 34/35: nothing of A's was sent as B; S was never created for B.
    expect(device.server.batches.flatMap((batch) => batch.commandIds)).not.toContain(commandX);
    expect(device.server.sessionOwners.has(sessionS)).toBe(false);

    await app.switchTo(session("sub-a"));
    // 37: the same pending commands are still there.
    expect(device.outboxRows(A.userId).map((row) => row.command_id)).toEqual(aPending.map((row) => row.command_id));
    // 38/39/40
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.server.batches).toEqual([{ actorUserId: A.userId, ownerUserId: A.userId, commandIds: aPending.map((row) => row.command_id) }]);
    expect(device.server.sessionOwners.get(sessionS)).toBe(A.userId);
    expect(device.outboxRows(A.userId).every((row) => row.status === "SYNCED")).toBe(true);
  });

  it("ISO-30 + offline: A's outbox stays pending while offline and while B is active; it drains as A only when A returns online", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a"));
    await app.settle();
    await startAndLogFirstSet(app.runtime);
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.outboxRows(A.userId).every((row) => row.status === "RETRY")).toBe(true);

    await app.switchTo(session("sub-b"));
    device.server.online = true;
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.outboxRows(A.userId).every((row) => row.status === "RETRY")).toBe(true);

    await app.switchTo(session("sub-a"));
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.outboxRows(A.userId).every((row) => row.status === "SYNCED")).toBe(true);
    expect(device.server.batches.every((batch) => batch.actorUserId === batch.ownerUserId)).toBe(true);
  });

  it("GATE-8 / AUTH-LOCAL-003: a new token for A keeps the same runtime and database; Resume and sync continue with the new token", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a", "1"));
    await app.settle();
    const sessionId = await startAndLogFirstSet(app.runtime);
    const runtimeBefore = app.runtime;

    await app.switchTo(session("sub-a", "2"));
    expect(app.runtime).toBe(runtimeBefore);
    expect(device.openedFiles).toEqual([athleteDatabaseName(A.userId)]);
    expect((await app.runtime.workoutApplicationService.getActiveWorkoutSession())?.id).toBe(sessionId);

    device.server.online = true;
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.server.batches).toHaveLength(1);
    expect(device.server.batches[0]).toMatchObject({ actorUserId: A.userId, ownerUserId: A.userId });
  });

  it("PROCESS DEATH / OFFLINE: A ACTIVE -> kill -> relaunch offline as known A -> READY offline, Resume intact -> network returns -> A syncs", async () => {
    device.server.online = false;
    const first = device.launch(session("sub-a"));
    await first.settle();
    const sessionId = await startAndLogFirstSet(first.runtime);
    await first.kill();

    device.meOnline = false;
    const relaunched = device.launch(session("sub-a", "relaunch"));
    await relaunched.settle();
    expect(relaunched.state).toMatchObject({ status: "READY", verification: "OFFLINE_BINDING", identity: A });
    const resumed = await relaunched.runtime.workoutApplicationService.getActiveWorkoutSession();
    expect(resumed?.id).toBe(sessionId);
    expect(resumed?.exercises[0]?.sets).toHaveLength(1);

    // AUTH-018: reachability alone never releases the outbox — only a fresh `/me` for the same owner does.
    await relaunched.network(false);
    device.server.online = true;
    const pendingBefore = device.outboxRows(A.userId);
    await expect(relaunched.runtime.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toBeInstanceOf(SyncNotPermittedError);
    expect(device.server.batches).toEqual([]);
    expect(device.outboxRows(A.userId)).toEqual(pendingBefore);

    device.meOnline = true;
    await relaunched.network(true);
    expect(relaunched.state).toMatchObject({ status: "READY", verification: "ONLINE", identity: A });
    await relaunched.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.server.sessionOwners.get(sessionId)).toBe(A.userId);
    expect(device.server.receipts.size).toBe(pendingBefore.length);
  });

  it("AUTH-013/014: the session is revoked mid-workout -> the SAME runtime keeps logging + finishes locally, sync pauses; same-owner re-auth syncs every command exactly once", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a", "1"));
    await app.settle();
    const runtimeA = app.runtime;
    const sessionId = await startAndLogFirstSet(runtimeA);

    // The auth server revokes A's session; the next sync gets 401 (no refresh possible) -> re-auth.
    device.server.revokedTokens.add(session("sub-a", "1").accessToken);
    device.server.online = true;
    await expect(runtimeA.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toThrow();
    await app.settle();
    expect(app.state).toMatchObject({ status: "READY", identity: A, auth: "REAUTH_REQUIRED" });
    expect(app.runtime).toBe(runtimeA);
    expect(device.openedFiles).toEqual([athleteDatabaseName(A.userId)]);

    // Active Workout stays fully usable locally.
    await runtimeA.workoutApplicationService.completeSet(
      {
        workoutSessionId: sessionId,
        prescriptionExerciseId: "ex-bench",
        exerciseRef: "bench-press",
        exerciseDisplayName: "Bench Press",
        exerciseOrder: 0,
        prescriptionSetId: "set-2",
        setOrder: 1,
        actualReps: 8,
        actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
        setType: "WORKING",
      },
      90,
    );
    await runtimeA.workoutApplicationService.finishWorkoutSession(sessionId);
    const pending = device.outboxRows(A.userId);
    expect(pending.map((row) => row.command_type)).toEqual(["START_WORKOUT_SESSION_V1", "COMPLETE_SET_V1", "COMPLETE_SET_V1", "FINISH_WORKOUT_SESSION_V1"]);
    await expect(runtimeA.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toBeInstanceOf(SyncNotPermittedError);
    expect(device.server.receipts.size).toBe(0);
    expect(device.outboxRows(A.userId)).toEqual(pending);

    // Same email signs in again: same subject, new token -> /me verifies the same userId -> sync resumes in place.
    await app.switchTo(session("sub-a", "2"));
    expect(app.state).toMatchObject({ status: "READY", identity: A, auth: "VALID", verification: "ONLINE" });
    expect(app.runtime).toBe(runtimeA);
    await runtimeA.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.outboxRows(A.userId).every((row) => row.status === "SYNCED")).toBe(true);
    expect(device.server.receipts.size).toBe(pending.length);
    expect(device.server.batches.every((batch) => batch.actorUserId === A.userId && batch.ownerUserId === A.userId)).toBe(true);
    expect(device.server.sessionOwners.get(sessionId)).toBe(A.userId);
  });

  it("AUTH-015/021: re-auth as ANOTHER athlete while A awaits re-auth disposes A first; B sees nothing of A; A's commands never leave as B; A returns intact", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a", "1"));
    await app.settle();
    const aSessionId = await startAndLogFirstSet(app.runtime);
    const aPending = device.outboxRows(A.userId);
    device.server.revokedTokens.add(session("sub-a", "1").accessToken);
    device.server.online = true;
    await expect(app.runtime.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toThrow();
    await app.settle();
    expect(app.state).toMatchObject({ status: "READY", auth: "REAUTH_REQUIRED" });

    await app.switchTo(session("sub-b"));
    expect(app.runtime.ownerUserId).toBe(B.userId);
    expect(device.openHandles).toEqual(new Set([athleteDatabaseName(B.userId)]));
    expect(await app.runtime.workoutApplicationService.getActiveWorkoutSession()).toBeUndefined();
    expect(await app.runtime.workoutApplicationService.getPreviousExercisePerformance("bench-press", aSessionId)).toBeUndefined();
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.server.receipts.size).toBe(0);

    await app.switchTo(session("sub-a", "2"));
    expect((await app.runtime.workoutApplicationService.getActiveWorkoutSession())?.id).toBe(aSessionId);
    expect(device.outboxRows(A.userId).map((row) => row.command_id)).toEqual(aPending.map((row) => row.command_id));
    await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(device.server.batches.every((batch) => batch.actorUserId === batch.ownerUserId)).toBe(true);
    expect(device.server.sessionOwners.get(aSessionId)).toBe(A.userId);
  });

  it("AUTH-019: the sync endpoint being unreachable is a retry, never an invalid session (no re-auth, runtime unchanged)", async () => {
    const app = device.launch(session("sub-a"));
    await app.settle();
    device.server.online = false;
    await startAndLogFirstSet(app.runtime);
    const result = await app.runtime.workoutApplicationService.syncPendingWorkoutCommands();
    expect(result.retried).toBeGreaterThan(0);
    await app.settle();
    expect(app.state).toMatchObject({ status: "READY", auth: "VALID", verification: "ONLINE" });
  });

  it("GATE-5 on a device: an unknown subject offline opens NO database (no Today/Resume/PREV possible)", async () => {
    device.meOnline = false;
    const app = device.launch(session("sub-b"));
    await app.settle();
    expect(app.state).toEqual({ status: "NEEDS_NETWORK" });
    expect(device.openedFiles).toEqual([]);
  });

  describe("bounded boot: the API accepts /me and never answers (real `fetchVerifiedMe` deadline)", () => {
    it("a known owner boots READY / OFFLINE_BINDING with sync off; Active Workout works; no outbox command leaves before an online /me", async () => {
      device.server.online = false;
      const first = device.launch(session("sub-a"));
      await first.settle();
      const sessionId = await startAndLogFirstSet(first.runtime);
      await first.kill();
      const pending = device.outboxRows(A.userId);

      device.meHangs = true;
      device.server.online = true; // the sync endpoint would answer — the gate must still not release the outbox
      const relaunched = device.launch(session("sub-a", "relaunch"));
      await relaunched.settle();
      expect(relaunched.state).toMatchObject({ status: "READY", verification: "OFFLINE_BINDING", identity: A });
      expect((await relaunched.runtime.workoutApplicationService.getActiveWorkoutSession())?.id).toBe(sessionId);
      await expect(relaunched.runtime.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toBeInstanceOf(SyncNotPermittedError);
      expect(device.server.batches).toEqual([]);
      expect(device.outboxRows(A.userId)).toEqual(pending);
    });

    it("then /me answers VERIFIED for the same userId -> ONLINE in the same runtime, each pending command synced exactly once", async () => {
      device.server.online = false;
      const first = device.launch(session("sub-a"));
      await first.settle();
      const sessionId = await startAndLogFirstSet(first.runtime);
      await first.kill();
      const pending = device.outboxRows(A.userId);

      device.meHangs = true;
      device.server.online = true;
      const relaunched = device.launch(session("sub-a", "relaunch"));
      await relaunched.settle();
      const runtime = relaunched.runtime;

      device.meHangs = false;
      await relaunched.network(true);
      expect(relaunched.state).toMatchObject({ status: "READY", verification: "ONLINE", auth: "VALID", identity: A });
      expect(relaunched.runtime).toBe(runtime);
      await runtime.workoutApplicationService.syncPendingWorkoutCommands();
      expect(device.server.batches.flatMap((batch) => batch.commandIds)).toEqual(pending.map((row) => row.command_id));
      expect(device.server.batches.every((batch) => batch.actorUserId === A.userId && batch.ownerUserId === A.userId)).toBe(true);
      expect(device.server.sessionOwners.get(sessionId)).toBe(A.userId);
    });

    it("then /me answers 401 -> REAUTH_REQUIRED, the SAME runtime is kept and sync stays off", async () => {
      device.server.online = false;
      const first = device.launch(session("sub-a"));
      await first.settle();
      await startAndLogFirstSet(first.runtime);
      await first.kill();

      device.meHangs = true;
      const relaunched = device.launch(session("sub-a", "relaunch"));
      await relaunched.settle();
      const runtime = relaunched.runtime;

      device.meHangs = false;
      device.server.revokedTokens.add(session("sub-a", "relaunch").accessToken);
      device.server.online = true;
      await relaunched.network(true);
      expect(relaunched.state).toMatchObject({ status: "READY", identity: A, auth: "REAUTH_REQUIRED" });
      expect(relaunched.runtime).toBe(runtime);
      await expect(runtime.workoutApplicationService.syncPendingWorkoutCommands()).rejects.toBeInstanceOf(SyncNotPermittedError);
      expect(device.server.batches).toEqual([]);
    });

    it("then /me maps the subject to ANOTHER userId -> BINDING_CONFLICT, the offline runtime is disposed (fail closed)", async () => {
      device.server.online = false;
      const first = device.launch(session("sub-a"));
      await first.settle();
      await startAndLogFirstSet(first.runtime);
      await first.kill();

      device.meHangs = true;
      const relaunched = device.launch(session("sub-a", "relaunch"));
      await relaunched.settle();
      expect(relaunched.state).toMatchObject({ status: "READY", verification: "OFFLINE_BINDING" });

      device.meHangs = false;
      device.meRemap.set("sub-a", B);
      device.server.online = true;
      await relaunched.network(true);
      expect(relaunched.state).toEqual({ status: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
      expect(device.openHandles.size).toBe(0);
      expect(device.server.batches).toEqual([]);
    });

    it("an unknown subject whose /me times out -> NEEDS_NETWORK and NO database is opened", async () => {
      device.meHangs = true;
      const app = device.launch(session("sub-b"));
      await app.settle();
      expect(app.state).toEqual({ status: "NEEDS_NETWORK" });
      expect(device.openedFiles).toEqual([]);
    });
  });

  it("CRASH DURING SWITCH: A disposed, process dies before B opens -> relaunch as B opens B's file; A's file and outbox are untouched", async () => {
    device.server.online = false;
    const app = device.launch(session("sub-a"));
    await app.settle();
    await startAndLogFirstSet(app.runtime);
    const aRows = device.outboxRows(A.userId);
    device.meOnline = false; // B is unknown offline -> the transition stops after disposing A
    await app.switchTo(session("sub-b"));
    expect(app.state).toEqual({ status: "NEEDS_NETWORK" });
    expect(device.openHandles.size).toBe(0);
    await app.kill();

    device.meOnline = true;
    const relaunched = device.launch(session("sub-b"));
    await relaunched.settle();
    expect(relaunched.runtime.ownerUserId).toBe(B.userId);
    expect(device.outboxRows(A.userId)).toEqual(aRows);
  });
});
