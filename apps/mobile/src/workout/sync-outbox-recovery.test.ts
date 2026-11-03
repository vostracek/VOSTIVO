import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { SyncOutcome, SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse, WorkoutCommandV1 } from "@vostivo/contracts";
import { createEntityId, type ExternalWeightLoad, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { WorkoutRepository } from "./workout-repository";
import { SyncEngine } from "./sync-engine";
import { FetchWorkoutSyncApiClient } from "./workout-sync-api-client";
import { RuntimeOwnerMismatchError, SessionInvalidError, type AuthTokenProvider } from "./auth-token-provider";
import { WorkoutSyncCoordinator, type SyncScheduler } from "../infrastructure/workout-sync-coordinator";
import { unresolvedSyncNotice } from "./unresolved-sync-notice";

/**
 * CC-03 — D-SYNC-1 outbox recovery, on the REAL SyncEngine, the REAL
 * FetchWorkoutSyncApiClient and the REAL repository SQL on a file-backed
 * SQLite. Only `fetch` is faked, by a small server that keeps the real
 * contract: request-level validation failure = 400 for the WHOLE request
 * before anything is processed (CC01-BATCH-001), otherwise per-command
 * acknowledgements with owner-scoped idempotent receipts (replay =
 * DUPLICATE). It also REJECTs a set/finish whose session it has never seen,
 * so a broken intra-session dependency would be visible.
 */
const OWNER = "0190a000-0000-7000-8000-00000000000a";
const LOAD: ExternalWeightLoad = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };
const PRESCRIPTION: WorkoutPrescriptionV1 = {
  schemaVersion: 1,
  prescriptionId: "cc03-prescription",
  name: "CC03 Upper",
  exercises: [
    {
      prescriptionExerciseId: "cc03-ex-1",
      exerciseRef: "bench-press",
      displayName: "Bench Press",
      order: 0,
      sets: [1, 2, 3, 4, 5, 6].map((n) => ({
        prescriptionSetId: `cc03-set-${n}`,
        order: n - 1,
        targetReps: { kind: "RANGE" as const, minReps: 8, maxReps: 12 },
        targetLoad: LOAD,
        restSeconds: 90,
        setType: "WORKING" as const,
      })),
    },
  ],
};

type ServerMode = "normal" | "reject-all-400" | "http-500" | "http-429" | "offline" | "http-401" | "owner-mismatch" | "lose-ack";

class FakeSyncServer {
  mode: ServerMode = "normal";
  /** Command ids this server refuses at request level (whole request -> 400). */
  readonly invalid = new Set<string>();
  /** Command ids this server answers with a per-command outcome instead of applying. */
  readonly forcedOutcome = new Map<string, SyncOutcome>();
  readonly requests: string[][] = [];
  readonly applyCount = new Map<string, number>();
  private readonly receipts = new Map<string, SyncOutcome>();
  private readonly sessions = new Set<string>();
  private readonly setSessions = new Map<string, string>();
  /** One-shot mode overrides, consumed per request in order. */
  readonly script: ServerMode[] = [];

  handle(init: { body: string }): Promise<Response> {
    const request = JSON.parse(init.body) as SyncWorkoutCommandsRequest;
    const ids = request.commands.map((command) => command.commandId);
    this.requests.push(ids);
    const mode = this.script.shift() ?? this.mode;
    if (mode === "offline") return Promise.reject(new TypeError("Network request failed"));
    if (mode === "http-500") return Promise.resolve(new Response("{}", { status: 503 }));
    if (mode === "http-429") return Promise.resolve(new Response("{}", { status: 429 }));
    if (mode === "http-401") return Promise.resolve(new Response("{}", { status: 401 }));
    if (mode === "owner-mismatch") return Promise.resolve(new Response(JSON.stringify({ message: "SYNC_OWNER_MISMATCH" }), { status: 409 }));
    if (mode === "reject-all-400" || ids.some((id) => this.invalid.has(id))) {
      return Promise.resolve(new Response(JSON.stringify({ statusCode: 400, message: ["invalid"] }), { status: 400 }));
    }
    const acknowledgements = request.commands.map((command) => ({ commandId: command.commandId, outcome: this.apply(command) }));
    if (mode === "lose-ack") return Promise.reject(new TypeError("Network request failed after the server committed"));
    const body: SyncWorkoutCommandsResponse = { acknowledgements };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }

  private apply(command: WorkoutCommandV1): SyncOutcome {
    const known = this.receipts.get(command.commandId);
    if (known !== undefined) return known === "APPLIED" ? "DUPLICATE" : known;
    const forced = this.forcedOutcome.get(command.commandId);
    const outcome = forced ?? this.decide(command);
    this.receipts.set(command.commandId, outcome);
    if (outcome === "APPLIED") this.applyCount.set(command.commandId, (this.applyCount.get(command.commandId) ?? 0) + 1);
    return outcome;
  }

  private decide(command: WorkoutCommandV1): SyncOutcome {
    switch (command.type) {
      case "START_WORKOUT_SESSION_V1":
        this.sessions.add(command.workoutSessionId);
        return "APPLIED";
      case "COMPLETE_SET_V1":
        if (!this.sessions.has(command.workoutSessionId)) return "REJECTED";
        this.setSessions.set(command.performedSetId, command.workoutSessionId);
        return "APPLIED";
      case "REOPEN_SET_V1":
        return this.setSessions.has(command.performedSetId) ? "APPLIED" : "REJECTED";
      case "FINISH_WORKOUT_SESSION_V1":
        return this.sessions.has(command.workoutSessionId) ? "APPLIED" : "REJECTED";
    }
  }

  delivered(): Set<string> {
    return new Set(this.receipts.keys());
  }
}

const tokenProvider: AuthTokenProvider = { getAccessToken: () => Promise.resolve("synthetic-test-token") };

interface OutboxRow {
  readonly commandId: string;
  readonly type: string;
  readonly status: string;
  readonly payload: string;
}

describe("CC-03 D-SYNC-1 outbox recovery (real SyncEngine + real SQLite)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;
  let server: FakeSyncServer;

  function open(): void {
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
  }

  function engine(batchSize?: number): SyncEngine {
    return new SyncEngine(OWNER, repository, tokenProvider, new FetchWorkoutSyncApiClient("http://sync.invalid"), batchSize);
  }

  function rows(): OutboxRow[] {
    return connection.db
      .all<{ command_id: string; command_type: string; status: string; payload_json: string }>(
        sql`SELECT command_id, command_type, status, payload_json FROM sync_outbox ORDER BY created_at ASC, rowid ASC`,
      )
      .map((row) => ({ commandId: row.command_id, type: row.command_type, status: row.status, payload: row.payload_json }));
  }

  function statusOf(commandId: string): string | undefined {
    return rows().find((row) => row.commandId === commandId)?.status;
  }

  function count(table: "local_workout_sessions" | "local_performed_sets" | "sync_outbox"): number {
    return connection.db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))?.n ?? -1;
  }

  /** A raw outbox row, as an older/corrupted client could have stored it. */
  function insertRaw(commandId: string, type: string, payload: Record<string, unknown>): void {
    const createdAt = new Date().toISOString();
    const json = JSON.stringify({ commandId, type, schemaVersion: 1, createdAt, ...payload });
    connection.db.run(
      sql`INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, status, created_at, updated_at)
          VALUES (${commandId}, ${type}, 1, ${json}, 'PENDING', ${createdAt}, ${createdAt})`,
    );
  }

  /** A complete local session: START, `sets` x COMPLETE_SET, FINISH. Returns its command ids in order. */
  async function loggedSession(sets: number, options: { finish?: boolean } = {}): Promise<{ sessionId: string; start: string; sets: string[]; finish?: string; performedSetIds: string[] }> {
    const before = new Set(rows().map((row) => row.commandId));
    const started = await repository.startWorkoutSession(PRESCRIPTION);
    if (started.status !== "STARTED") throw new Error("expected STARTED");
    const sessionId = started.session.id;
    let performedExerciseId: string | undefined;
    const performedSetIds: string[] = [];
    for (let n = 1; n <= sets; n += 1) {
      const outcome = await repository.completeSet({
        workoutSessionId: sessionId,
        ...(performedExerciseId === undefined ? {} : { performedExerciseId }),
        prescriptionExerciseId: "cc03-ex-1",
        exerciseRef: "bench-press",
        exerciseDisplayName: "Bench Press",
        exerciseOrder: 0,
        prescriptionSetId: `cc03-set-${n}`,
        setOrder: n - 1,
        actualReps: 10,
        actualLoad: LOAD,
        setType: "WORKING",
      });
      if (outcome.status !== "COMPLETED") throw new Error(`expected COMPLETED, got ${outcome.status}`);
      performedExerciseId = outcome.result.performedExerciseId;
      performedSetIds.push(outcome.result.performedSetId);
    }
    if (options.finish !== false) {
      const finished = await repository.finishWorkoutSession(sessionId);
      if (finished.status !== "FINISHED") throw new Error(`expected FINISHED, got ${finished.status}`);
    }
    const created = rows().filter((row) => !before.has(row.commandId));
    const byType = (type: string): string[] => created.filter((row) => row.type === type).map((row) => row.commandId);
    return {
      sessionId,
      start: byType("START_WORKOUT_SESSION_V1")[0]!,
      sets: byType("COMPLETE_SET_V1"),
      ...(options.finish === false ? {} : { finish: byType("FINISH_WORKOUT_SESSION_V1")[0]! }),
      performedSetIds,
    };
  }

  async function drain(target: SyncEngine, maxPasses = 10): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await target.syncPendingCommands().catch(() => undefined);
      if (result === undefined || result.attempted === 0) return;
    }
  }

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-cc03-sync-${createEntityId()}.db`;
    open();
    server = new FakeSyncServer();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => server.handle(init)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    connection.close();
    rmSync(path, { force: true });
  });

  it("CC03-SYNC-001: an invalid command among valid ones is isolated; the valid commands of its own and another session are delivered", async () => {
    const a = await loggedSession(2);
    const b = await loggedSession(1);
    server.invalid.add(a.sets[1]!);

    await drain(engine());

    expect(statusOf(a.sets[1]!)).toBe("BLOCKED");
    expect(statusOf(a.start)).toBe("SYNCED");
    expect(statusOf(a.sets[0]!)).toBe("SYNCED");
    expect(server.delivered().has(a.finish!)).toBe(false);
    expect(["PENDING", "RETRY"]).toContain(statusOf(a.finish!));
    for (const id of [b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("SYNCED");
    expect(rows().some((row) => row.status === "REJECTED")).toBe(false);
  });

  it("CC03-SYNC-002: commands that depend on a blocked command (same session) are held, never sent out of order", async () => {
    const a = await loggedSession(3);
    const b = await loggedSession(1);
    server.invalid.add(a.start);

    await drain(engine());

    expect(statusOf(a.start)).toBe("BLOCKED");
    const delivered = server.delivered();
    for (const id of [...a.sets, a.finish!]) {
      expect(delivered.has(id)).toBe(false);
      expect(["PENDING", "RETRY"]).toContain(statusOf(id));
    }
    for (const id of [b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("SYNCED");
    expect(rows().some((row) => row.status === "REJECTED")).toBe(false);
  });

  it("CC03-SYNC-003: blocked and held commands do not consume the pending-selection window", async () => {
    const a = await loggedSession(6);
    const b = await loggedSession(1);
    server.invalid.add(a.start);

    await drain(engine(3), 20);

    for (const id of [b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("SYNCED");
    const selectable = await repository.getPendingCommands(3);
    expect(selectable).toEqual([]);
  });

  it("CC03-SYNC-004: when every individual request is also refused, nothing is classified as blocked and no timer retry is requested", async () => {
    const a = await loggedSession(1);
    const b = await loggedSession(1);
    server.mode = "reject-all-400";
    const sent = engine();

    const first = await sent.syncPendingCommands();

    expect(first.retried).toBe(0);
    expect(first.requestRejected).toBe(true);
    for (const id of [a.start, ...a.sets, a.finish!, b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("RETRY");
    expect(rows().some((row) => row.status === "BLOCKED" || row.status === "REJECTED")).toBe(false);
  });

  it("CC03-SYNC-005: a lone pending command refused with 400 leaves the retry loop as BLOCKED (recoverable, not deleted)", async () => {
    const started = await repository.startWorkoutSession(PRESCRIPTION);
    if (started.status !== "STARTED") throw new Error("expected STARTED");
    const [start] = rows();
    server.invalid.add(start!.commandId);

    const result = await engine().syncPendingCommands();

    expect(result).toMatchObject({ attempted: 1, retried: 0, blocked: 1 });
    expect(statusOf(start!.commandId)).toBe("BLOCKED");
    expect(await repository.getPendingCommands(25)).toEqual([]);
  });

  it("CC03-SYNC-006: after an app restart, blocked commands are probed once more; a server that now accepts them receives them in order, without duplicates", async () => {
    const a = await loggedSession(2);
    server.invalid.add(a.start);
    await drain(engine());
    expect(statusOf(a.start)).toBe("BLOCKED");

    connection.close();
    open();
    server.invalid.clear();
    await drain(engine());

    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("SYNCED");
    for (const id of [a.start, ...a.sets, a.finish!]) expect(server.applyCount.get(id)).toBe(1);
    const order = server.requests.flat().filter((id) => [a.start, ...a.sets, a.finish!].includes(id));
    const firstDelivery = [a.start, ...a.sets, a.finish!].map((id) => order.lastIndexOf(id));
    expect([...firstDelivery].sort((x, y) => x - y)).toEqual(firstDelivery);
  });

  it("CC03-SYNC-007: after an app restart with the command still refused, it is blocked again and its dependents stay held — never REJECTED", async () => {
    const a = await loggedSession(1);
    server.invalid.add(a.start);
    await drain(engine());

    connection.close();
    open();
    await drain(engine());

    expect(statusOf(a.start)).toBe("BLOCKED");
    expect(["PENDING", "RETRY"]).toContain(statusOf(a.sets[0]!));
    expect(["PENDING", "RETRY"]).toContain(statusOf(a.finish!));
    expect(rows().some((row) => row.status === "REJECTED")).toBe(false);
  });

  it("CC03-SYNC-008: a lost acknowledgement is replayed with the same command ids and resolves as DUPLICATE, applied exactly once", async () => {
    const a = await loggedSession(2);
    server.script.push("lose-ack");
    const sent = engine();

    const first = await sent.syncPendingCommands();
    expect(first.retried).toBe(4);
    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("RETRY");

    await sent.syncPendingCommands();

    for (const id of [a.start, ...a.sets, a.finish!]) {
      expect(statusOf(id)).toBe("SYNCED");
      expect(server.applyCount.get(id)).toBe(1);
    }
    expect(server.requests[0]).toEqual(server.requests[1]);
  });

  it.each<[ServerMode, string]>([
    ["http-500", "5xx"],
    ["http-429", "429 rate limit"],
    ["offline", "offline"],
  ])("CC03-SYNC-009: %s (%s) stays a transient, timer-retried failure — nothing blocked", async (mode) => {
    const a = await loggedSession(1);
    server.mode = mode;

    const result = await engine().syncPendingCommands();

    expect(result.retried).toBe(3);
    expect(result.blocked ?? 0).toBe(0);
    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("RETRY");
  });

  it("CC03-SYNC-010: 401 (session invalid) and 409 owner mismatch pause sync without blocking anything", async () => {
    const a = await loggedSession(1);
    server.mode = "http-401";
    await expect(engine().syncPendingCommands()).rejects.toBeInstanceOf(SessionInvalidError);
    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("RETRY");

    server.mode = "owner-mismatch";
    await expect(engine().syncPendingCommands()).rejects.toBeInstanceOf(RuntimeOwnerMismatchError);
    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("RETRY");
  });

  it("CC03-SYNC-011: a transient failure while isolating stops the probe; nothing unprobed is classified", async () => {
    const a = await loggedSession(1);
    const b = await loggedSession(1, { finish: false });
    server.invalid.add(b.sets[0]!);
    // whole batch 400, then the first singleton probe succeeds, then the network drops.
    server.script.push("normal", "normal", "offline");

    const result = await engine().syncPendingCommands();

    expect(statusOf(a.start)).toBe("SYNCED");
    expect(result.blocked ?? 0).toBe(0);
    expect(rows().some((row) => row.status === "BLOCKED")).toBe(false);
    for (const id of [a.sets[0]!, a.finish!, b.start, b.sets[0]!]) expect(statusOf(id)).toBe("RETRY");
  });

  it("CC03-SYNC-012: REOPEN_SET_V1 (no session id in its payload) is held behind a blocked command of its own session", async () => {
    const a = await loggedSession(1, { finish: false });
    const reopened = await repository.reopenSet(a.performedSetIds[0]!);
    expect(reopened.status).toBe("REOPENED");
    const reopen = rows().find((row) => row.type === "REOPEN_SET_V1")!.commandId;
    server.invalid.add(a.sets[0]!);

    await drain(engine());

    expect(statusOf(a.start)).toBe("SYNCED");
    expect(statusOf(a.sets[0]!)).toBe("BLOCKED");
    expect(server.delivered().has(reopen)).toBe(false);
    expect(["PENDING", "RETRY"]).toContain(statusOf(reopen));
  });

  it("CC03-SYNC-013: blocked, waiting, REJECTED and CONFLICT commands are visible as unresolved sync state", async () => {
    const a = await loggedSession(1);
    const b = await loggedSession(2);
    server.invalid.add(a.start);
    server.forcedOutcome.set(b.sets[0]!, "REJECTED");
    server.forcedOutcome.set(b.sets[1]!, "CONFLICT");

    await drain(engine());

    expect(await repository.getUnresolvedSyncSummary()).toEqual({ blocked: 1, waitingOnBlocked: 2, rejected: 1, conflicted: 1 });
  });

  it("CC03-SYNC-015: REJECTED and CONFLICT are terminal — never re-sent, not on later passes and not after an app restart", async () => {
    const a = await loggedSession(2);
    server.forcedOutcome.set(a.sets[0]!, "REJECTED");
    server.forcedOutcome.set(a.sets[1]!, "CONFLICT");
    await drain(engine());
    const sentBefore = server.requests.flat().filter((id) => id === a.sets[0] || id === a.sets[1]).length;

    await drain(engine());
    connection.close();
    open();
    await drain(engine());

    expect(statusOf(a.sets[0]!)).toBe("REJECTED");
    expect(statusOf(a.sets[1]!)).toBe("CONFLICT");
    expect(server.requests.flat().filter((id) => id === a.sets[0] || id === a.sets[1])).toHaveLength(sentBefore);
    expect(await repository.getPendingCommands(25)).toEqual([]);
  });

  it("CC03-SYNC-014: no recovery path deletes or rewrites local workout data or outbox payloads", async () => {
    await loggedSession(2);
    await loggedSession(1);
    const before = { outbox: rows().map(({ commandId, payload }) => ({ commandId, payload })), sessions: count("local_workout_sessions"), sets: count("local_performed_sets") };
    server.invalid.add(before.outbox[0]!.commandId);

    await drain(engine());
    server.mode = "reject-all-400";
    await drain(engine(), 3);
    connection.close();
    open();
    server.mode = "normal";
    await drain(engine());

    expect(rows().map(({ commandId, payload }) => ({ commandId, payload }))).toEqual(before.outbox);
    expect(count("local_workout_sessions")).toBe(before.sessions);
    expect(count("local_performed_sets")).toBe(before.sets);
  });

  it("CC03-SYS-001: a one-command batch refused at request level is BLOCKED (visible), re-probed exactly once per launch, and syncs once the server accepts it", async () => {
    await repository.startWorkoutSession(PRESCRIPTION);
    const [start] = rows();
    server.mode = "reject-all-400";

    const launch1 = engine();
    await drain(launch1);
    await drain(launch1);
    expect(statusOf(start!.commandId)).toBe("BLOCKED");
    expect(server.requests).toHaveLength(1);
    expect(unresolvedSyncNotice(await repository.getUnresolvedSyncSummary(), false)).not.toBeNull();

    connection.close();
    open();
    const launch2 = engine();
    await drain(launch2);
    await drain(launch2);
    expect(statusOf(start!.commandId)).toBe("BLOCKED");
    expect(server.requests).toHaveLength(2);

    connection.close();
    open();
    server.mode = "normal";
    await drain(engine());
    expect(statusOf(start!.commandId)).toBe("SYNCED");
    expect(server.applyCount.get(start!.commandId)).toBe(1);
  });

  it("CC03-SYS-002: a version mismatch (every probe refused) classifies nothing, is visible via requestRejected, and recovers in order after an update", async () => {
    const a = await loggedSession(2);
    const b = await loggedSession(1);
    const all = [a.start, ...a.sets, a.finish!, b.start, ...b.sets, b.finish!];
    server.mode = "reject-all-400";

    const result = await engine().syncPendingCommands();
    expect(result).toMatchObject({ requestRejected: true, retried: 0 });
    expect(rows().filter((row) => row.status === "BLOCKED")).toEqual([]);
    expect(unresolvedSyncNotice(await repository.getUnresolvedSyncSummary(), result.requestRejected === true)).not.toBeNull();
    // one whole-batch request + one probe per session (dependents are held, not sent)
    expect(server.requests).toHaveLength(3);

    connection.close();
    open();
    server.mode = "normal";
    await drain(engine());
    for (const id of all) {
      expect(statusOf(id)).toBe("SYNCED");
      expect(server.applyCount.get(id)).toBe(1);
    }
  });

  it("CC03-SYS-003: mixed per-command and request-level failures in one pass are each classified on their own", async () => {
    const a = await loggedSession(1);
    const b = await loggedSession(1);
    const c = await loggedSession(1);
    server.invalid.add(a.start);
    server.forcedOutcome.set(b.sets[0]!, "REJECTED");

    await drain(engine());

    expect(statusOf(a.start)).toBe("BLOCKED");
    expect(["PENDING", "RETRY"]).toContain(statusOf(a.sets[0]!));
    expect(statusOf(b.start)).toBe("SYNCED");
    expect(statusOf(b.sets[0]!)).toBe("REJECTED");
    expect(statusOf(b.finish!)).toBe("SYNCED");
    for (const id of [c.start, ...c.sets, c.finish!]) expect(statusOf(id)).toBe("SYNCED");
    expect(await repository.getUnresolvedSyncSummary()).toEqual({ blocked: 1, waitingOnBlocked: 2, rejected: 1, conflicted: 0 });
  });

  it.each<[ServerMode, string]>([
    ["offline", "network failure"],
    ["http-401", "401 session invalid"],
    ["owner-mismatch", "409 owner mismatch"],
  ])("CC03-SYS-004: after a restart, a %s (%s) during the re-probe keeps the command BLOCKED and visible; it is re-probed once the server answers", async (mode) => {
    const a = await loggedSession(1);
    server.invalid.add(a.start);
    await drain(engine());
    expect(statusOf(a.start)).toBe("BLOCKED");

    connection.close();
    open();
    server.invalid.clear();
    server.mode = mode;
    const relaunched = engine();
    await relaunched.syncPendingCommands().catch(() => undefined);

    expect(statusOf(a.start)).toBe("BLOCKED");
    expect((await repository.getUnresolvedSyncSummary()).blocked).toBe(1);
    expect(server.delivered().has(a.start)).toBe(false);

    server.mode = "normal";
    await drain(relaunched);
    for (const id of [a.start, ...a.sets, a.finish!]) expect(statusOf(id)).toBe("SYNCED");
  });

  it("CC03-DEP-001: a refused command of UNKNOWN session holds every session that existed before it; a session started after it still syncs", async () => {
    const started = await repository.startWorkoutSession(PRESCRIPTION);
    if (started.status !== "STARTED") throw new Error("expected STARTED");
    const aStart = rows().at(-1)!.commandId;
    const malformed = createEntityId();
    insertRaw(malformed, "COMPLETE_SET_V1", { revision: 1 }); // no workoutSessionId: unknown group
    const finished = await repository.finishWorkoutSession(started.session.id);
    expect(finished.status).toBe("FINISHED");
    const aFinish = rows().at(-1)!.commandId;
    const b = await loggedSession(1);
    server.invalid.add(malformed);

    await drain(engine());

    expect(statusOf(aStart)).toBe("SYNCED");
    expect(statusOf(malformed)).toBe("BLOCKED");
    expect(server.delivered().has(aFinish)).toBe(false);
    expect(["PENDING", "RETRY"]).toContain(statusOf(aFinish));
    for (const id of [b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("SYNCED");
    expect((await repository.getUnresolvedSyncSummary()).waitingOnBlocked).toBe(1);
  });

  it("CC03-DEP-002: a command whose session cannot be resolved (REOPEN of an unknown set) never overtakes an earlier BLOCKED command", async () => {
    const a = await loggedSession(1);
    server.invalid.add(a.start);
    const orphanReopen = createEntityId();
    insertRaw(orphanReopen, "REOPEN_SET_V1", { performedSetId: createEntityId(), revision: 2, sessionSeq: 9 });
    const b = await loggedSession(1);

    await drain(engine());

    expect(statusOf(a.start)).toBe("BLOCKED");
    expect(server.delivered().has(orphanReopen)).toBe(false);
    expect(["PENDING", "RETRY"]).toContain(statusOf(orphanReopen));
    // b is a KNOWN session behind a KNOWN blocked session: independent, so it syncs.
    for (const id of [b.start, ...b.sets, b.finish!]) expect(statusOf(id)).toBe("SYNCED");
    expect((await repository.getUnresolvedSyncSummary()).waitingOnBlocked).toBe(3);
  });

  it("CC03-DEP-003: a malformed command with no refusal ahead of it is simply sent; the server decides", async () => {
    const lone = createEntityId();
    insertRaw(lone, "COMPLETE_SET_V1", { revision: 1 });
    server.forcedOutcome.set(lone, "REJECTED");

    await drain(engine());

    expect(statusOf(lone)).toBe("REJECTED");
  });

  function boundedCoordinator(syncEngine: SyncEngine, batchSize: number) {
    const timers: (() => void)[] = [];
    const scheduler: SyncScheduler = { setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} };
    const counter = { passes: 0 };
    const coordinator = new WorkoutSyncCoordinator(
      () => {
        counter.passes += 1;
        if (counter.passes > 20) return Promise.reject(new Error("unbounded sync loop"));
        return syncEngine.syncPendingCommands();
      },
      { scheduler, batchSize },
    );
    return { coordinator, timers, counter };
  }

  async function settle(): Promise<void> {
    // Let every coalesced follow-up pass finish (all I/O here is in-process).
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it("CC03-LOOP-001: the real coordinator over the real engine never loops on a systemic refusal and schedules no timer", async () => {
    await loggedSession(1);
    await loggedSession(1);
    server.mode = "reject-all-400";
    const { coordinator, timers, counter } = boundedCoordinator(engine(4), 4);

    coordinator.requestSync("launch");
    await settle();

    expect(counter.passes).toBe(1);
    expect(timers).toEqual([]);
    expect(coordinator.requestRejectedAtLastAttempt).toBe(true);
    expect(rows().every((row) => row.status === "RETRY" || row.status === "PENDING")).toBe(true);
    coordinator.dispose();
  });

  it("CC03-LOOP-002: when a full batch holds only one session, a systemic refusal cannot be told apart from a bad command — the START is BLOCKED (recoverable), the passes stay bounded and no timer runs", async () => {
    const a = await loggedSession(3);
    const b = await loggedSession(3);
    server.mode = "reject-all-400";
    const { coordinator, timers, counter } = boundedCoordinator(engine(4), 4);

    coordinator.requestSync("launch");
    await settle();

    expect(counter.passes).toBeLessThanOrEqual(3);
    expect(timers).toEqual([]);
    expect(statusOf(a.start)).toBe("BLOCKED");
    expect(statusOf(b.start)).toBe("BLOCKED");
    expect(rows().some((row) => row.status === "REJECTED" || row.status === "SYNCED")).toBe(false);
    expect(await repository.getUnresolvedSyncSummary()).toMatchObject({ blocked: 2, waitingOnBlocked: 8 });
    coordinator.dispose();
  });
});
