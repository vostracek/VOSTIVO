import { describe, expect, it } from "vitest";
import { OTP_RESEND_COOLDOWN_MS, SignInFlowController, type SignInState } from "./sign-in-flow";
import type { AuthActionResult, EmailOtpSignIn } from "./supabase-auth-session-source";

class FakeSignIn implements EmailOtpSignIn {
  requests: string[] = [];
  verifications: { email: string; token: string; otpSentAt: number }[] = [];
  nextRequest: AuthActionResult = { ok: true };
  nextVerify: AuthActionResult = { ok: true };

  requestOtp(email: string): Promise<AuthActionResult> {
    this.requests.push(email);
    return Promise.resolve(this.nextRequest);
  }

  verifyOtp(email: string, token: string, otpSentAt: number): Promise<AuthActionResult> {
    this.verifications.push({ email, token, otpSentAt });
    return Promise.resolve(this.nextVerify);
  }
}

function harness() {
  const signIn = new FakeSignIn();
  let now = 1_000_000;
  const states: SignInState[] = [];
  const controller = new SignInFlowController({ signIn, now: () => now }, (state) => states.push(state));
  return { signIn, controller, advance: (ms: number) => (now += ms), now: () => now, current: () => controller.current };
}

describe("SignInFlowController — email + 6-digit OTP", () => {
  it("AUTH-001: signed out -> email -> code requested -> CODE step with a 60 s resend cooldown", async () => {
    const h = harness();
    h.controller.setEmail(" athlete@example.com ");
    await h.controller.submitEmail();
    expect(h.signIn.requests).toEqual(["athlete@example.com"]);
    expect(h.current()).toMatchObject({ step: "CODE", email: "athlete@example.com", code: "", otpSentAt: h.now() });
    expect(h.controller.resendSecondsRemaining()).toBe(60);
  });

  it("an invalid email never reaches Supabase", async () => {
    const h = harness();
    h.controller.setEmail("not-an-email");
    await h.controller.submitEmail();
    expect(h.signIn.requests).toEqual([]);
    expect(h.current()).toMatchObject({ step: "EMAIL", error: "INVALID_EMAIL" });
  });

  it("AUTH-002: the code accepts digits only (paste with spaces works), max 6; verify only with exactly 6 -> SIGNED_IN", async () => {
    const h = harness();
    h.controller.setEmail("a@b.cz");
    await h.controller.submitEmail();
    h.controller.setCode("12 34");
    expect(h.controller.canVerify()).toBe(false);
    h.controller.setCode("123 456 789");
    expect(h.current()).toMatchObject({ code: "123456" });
    await h.controller.submitCode();
    expect(h.signIn.verifications).toEqual([{ email: "a@b.cz", token: "123456", otpSentAt: 1_000_000 }]);
    expect(h.current()).toEqual({ step: "SIGNED_IN" });
  });

  it("AUTH-003: a wrong code shows INVALID_OTP and clears the input; a network failure keeps it for retry", async () => {
    const h = harness();
    h.controller.setEmail("a@b.cz");
    await h.controller.submitEmail();
    h.controller.setCode("000000");
    h.signIn.nextVerify = { ok: false, code: "INVALID_OTP" };
    await h.controller.submitCode();
    expect(h.current()).toMatchObject({ step: "CODE", code: "", error: "INVALID_OTP", busy: "IDLE" });

    h.controller.setCode("111111");
    h.signIn.nextVerify = { ok: false, code: "NETWORK_UNAVAILABLE" };
    await h.controller.submitCode();
    expect(h.current()).toMatchObject({ code: "111111", error: "NETWORK_UNAVAILABLE" });
  });

  it("resend honours the 60 s cooldown, restarts it (also after a refused resend) and verifies against the NEW send time", async () => {
    const h = harness();
    h.controller.setEmail("a@b.cz");
    await h.controller.submitEmail();
    await h.controller.resend();
    expect(h.signIn.requests).toHaveLength(1);

    h.advance(OTP_RESEND_COOLDOWN_MS);
    h.signIn.nextRequest = { ok: false, code: "RATE_LIMITED" };
    await h.controller.resend();
    expect(h.signIn.requests).toHaveLength(2);
    expect(h.current()).toMatchObject({ error: "RATE_LIMITED" });
    expect(h.controller.resendSecondsRemaining()).toBe(60);

    h.advance(OTP_RESEND_COOLDOWN_MS);
    h.signIn.nextRequest = { ok: true };
    await h.controller.resend();
    expect(h.current()).toMatchObject({ resent: true, otpSentAt: h.now(), error: null });
    h.controller.setCode("654321");
    await h.controller.submitCode();
    expect(h.signIn.verifications[0]?.otpSentAt).toBe(h.now());
  });

  it("change email returns to the EMAIL step with the address kept", async () => {
    const h = harness();
    h.controller.setEmail("a@b.cz");
    await h.controller.submitEmail();
    h.controller.changeEmail();
    expect(h.current()).toEqual({ step: "EMAIL", email: "a@b.cz", sending: false, error: null });
  });
});
