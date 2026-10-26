import { describe, expect, it } from "vitest";
import { RuntimeOwnerMismatchError, SessionInvalidError, SyncPausedError } from "../workout/auth-token-provider";
import type { AuthSession, AuthSessionSource } from "./auth-session";
import { OwnerBoundAuthTokenProvider } from "./owner-bound-auth-token-provider";

const OWNER = { provider: "supabase", providerSubject: "sub-a" } as const;

function sourceWith(session: AuthSession | null): AuthSessionSource {
  return { getSession: () => Promise.resolve(session), subscribe: () => () => {} };
}

describe("OwnerBoundAuthTokenProvider", () => {
  it("hands out the owner's access token", async () => {
    const provider = new OwnerBoundAuthTokenProvider(sourceWith({ ...OWNER, accessToken: "token-a" }), OWNER);
    await expect(provider.getAccessToken()).resolves.toBe("token-a");
  });

  it("another identity's session -> RuntimeOwnerMismatchError", async () => {
    const provider = new OwnerBoundAuthTokenProvider(sourceWith({ provider: "supabase", providerSubject: "sub-b", accessToken: "token-b" }), OWNER);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(RuntimeOwnerMismatchError);
  });

  it("AUTH-023: no session while re-auth is pending -> SessionInvalidError with sign-in copy, never the owner-mismatch text", async () => {
    const provider = new OwnerBoundAuthTokenProvider(sourceWith(null), OWNER);
    const error: unknown = await provider.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionInvalidError);
    // Still a paused-sync signal: the engine leaves the outbox untouched and schedules no backoff.
    expect(error).toBeInstanceOf(SyncPausedError);
    expect(error).not.toBeInstanceOf(RuntimeOwnerMismatchError);
    expect((error as Error).message).toBe("Sign in again to load your latest training.");
  });
});
