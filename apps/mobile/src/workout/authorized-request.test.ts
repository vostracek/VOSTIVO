import { describe, expect, it } from "vitest";
import { AuthServiceUnavailableError, type AuthTokenProvider, type UnauthorizedRecovery } from "./auth-token-provider";
import { sendWithAuthRecovery } from "./authorized-request";

class FakeProvider implements AuthTokenProvider {
  token = "t1";
  recoveries = 0;
  reports = 0;
  constructor(private readonly recovery: () => Promise<UnauthorizedRecovery>) {}
  getAccessToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  recoverFromUnauthorized(): Promise<UnauthorizedRecovery> {
    this.recoveries += 1;
    return this.recovery();
  }
  reportSessionInvalid(): Promise<void> {
    this.reports += 1;
    return Promise.resolve();
  }
}

describe("sendWithAuthRecovery — the one 401 policy", () => {
  it("AUTH-011: 401 -> one refresh -> exactly one retry with the new token", async () => {
    const provider = new FakeProvider(() => {
      provider.token = "t2";
      return Promise.resolve("REFRESHED");
    });
    const sent: string[] = [];
    const outcome = await sendWithAuthRecovery(provider, (token) => (sent.push(token), Promise.resolve(token === "t2" ? 200 : 401)), (status) => status === 401);
    expect(sent).toEqual(["t1", "t2"]);
    expect(outcome).toEqual({ result: 200, unauthorized: false });
  });

  it("AUTH-011: still 401 after the refresh -> no third send; the session is reported invalid once", async () => {
    const provider = new FakeProvider(() => Promise.resolve("REFRESHED"));
    let sends = 0;
    const outcome = await sendWithAuthRecovery(provider, () => (sends += 1, Promise.resolve(401)), (status) => status === 401);
    expect(sends).toBe(2);
    expect(provider.reports).toBe(1);
    expect(outcome.unauthorized).toBe(true);
  });

  it("an unrecoverable session -> no retry at all", async () => {
    const provider = new FakeProvider(() => Promise.resolve("SESSION_INVALID"));
    let sends = 0;
    const outcome = await sendWithAuthRecovery(provider, () => (sends += 1, Promise.resolve(401)), (status) => status === 401);
    expect(sends).toBe(1);
    expect(outcome.unauthorized).toBe(true);
  });

  it("AUTH-019: the auth service unreachable while refreshing propagates as AuthServiceUnavailableError (offline), not an invalid session", async () => {
    const provider = new FakeProvider(() => Promise.reject(new AuthServiceUnavailableError()));
    await expect(sendWithAuthRecovery(provider, () => Promise.resolve(401), (status) => status === 401)).rejects.toBeInstanceOf(AuthServiceUnavailableError);
    expect(provider.reports).toBe(0);
  });
});
