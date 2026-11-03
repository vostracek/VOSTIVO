import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncWorkoutCommandsRequest } from "@vostivo/contracts";
import { RuntimeOwnerMismatchError } from "./auth-token-provider";
import { FetchWorkoutSyncApiClient, RequestRejectedSyncResponse, TransientSyncFailure, UnauthorizedSyncResponse } from "./workout-sync-api-client";

/**
 * CC-03: the HTTP status of a whole sync request is classified into a typed
 * failure. A 400/413/422 is a request-level refusal (the server validated
 * the whole batch before processing anything — CC01-BATCH-001), NOT proof
 * that any single command is permanently invalid.
 */
const REQUEST: SyncWorkoutCommandsRequest = { ownerUserId: "0190a000-0000-7000-8000-00000000000a", commands: [] };

function respond(status: number, body: unknown = {}): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
}

async function failureOf(): Promise<unknown> {
  return new FetchWorkoutSyncApiClient("http://sync.invalid").syncCommands("synthetic-test-token", REQUEST).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("FetchWorkoutSyncApiClient failure classification (CC-03)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([400, 413, 422])("%i is a typed request-level rejection carrying its status", async (status) => {
    respond(status, { statusCode: status, message: ["invalid"] });
    const error = await failureOf();
    expect(error).toBeInstanceOf(RequestRejectedSyncResponse);
    expect((error as RequestRejectedSyncResponse).status).toBe(status);
  });

  it.each([408, 429, 500, 502, 503])("%i is transient", async (status) => {
    respond(status);
    expect(await failureOf()).toBeInstanceOf(TransientSyncFailure);
  });

  it("a network failure is transient", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Network request failed"))));
    expect(await failureOf()).toBeInstanceOf(TransientSyncFailure);
  });

  it("401 is an unauthorized response, 409 SYNC_OWNER_MISMATCH pauses", async () => {
    respond(401);
    expect(await failureOf()).toBeInstanceOf(UnauthorizedSyncResponse);
    respond(409, { message: "SYNC_OWNER_MISMATCH" });
    expect(await failureOf()).toBeInstanceOf(RuntimeOwnerMismatchError);
  });

  it("any other 4xx stays an unclassified error — never a request rejection", async () => {
    respond(403);
    const error = await failureOf();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestRejectedSyncResponse);
    expect(error).not.toBeInstanceOf(TransientSyncFailure);
  });
});
