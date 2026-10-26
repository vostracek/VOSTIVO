import type { AuthErrorCode } from "./auth-errors";
import type { EmailOtpSignIn } from "./supabase-auth-session-source";

/** Seconds before another code may be requested for the same email. */
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_LENGTH = 6;

export type SignInState =
  | { readonly step: "EMAIL"; readonly email: string; readonly sending: boolean; readonly error: AuthErrorCode | null }
  | {
      readonly step: "CODE";
      readonly email: string;
      readonly code: string;
      /** When the code currently in the inbox was requested. */
      readonly otpSentAt: number;
      readonly resendAvailableAt: number;
      readonly busy: "IDLE" | "VERIFYING" | "RESENDING";
      readonly error: AuthErrorCode | null;
      readonly resent: boolean;
    }
  /** Verified: the session source now has a session — the IdentityGate takes over (`/me`, binding, owner database). */
  | { readonly step: "SIGNED_IN" };

export interface SignInFlowPorts {
  readonly signIn: EmailOtpSignIn;
  now(): number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Auth Slice C — email + 6-digit OTP sign-in, framework-free (the screen in
 * `sign-in-screen.tsx` only renders it). V1 is OTP-only: no password, magic
 * link, social or anonymous sign-in. Never logs the email or the code.
 *
 * Signing in only creates a Supabase session. It never opens athlete data:
 * the IdentityGate then verifies `/me`, records the binding and opens THAT
 * user's database — the same path as every other identity change.
 */
export class SignInFlowController {
  private state: SignInState;

  constructor(
    private readonly ports: SignInFlowPorts,
    private readonly onChange: (state: SignInState) => void,
    initialEmail = "",
  ) {
    this.state = { step: "EMAIL", email: initialEmail, sending: false, error: null };
  }

  get current(): SignInState {
    return this.state;
  }

  setEmail(email: string): void {
    if (this.state.step !== "EMAIL" || this.state.sending) return;
    this.set({ ...this.state, email, error: null });
  }

  async submitEmail(): Promise<void> {
    const state = this.state;
    if (state.step !== "EMAIL" || state.sending) return;
    const email = state.email.trim();
    if (!EMAIL_PATTERN.test(email)) {
      this.set({ ...state, error: "INVALID_EMAIL" });
      return;
    }
    this.set({ ...state, email, sending: true, error: null });
    const result = await this.ports.signIn.requestOtp(email);
    if (this.state.step !== "EMAIL") return;
    if (!result.ok) {
      this.set({ step: "EMAIL", email, sending: false, error: result.code });
      return;
    }
    const sentAt = this.ports.now();
    this.set({ step: "CODE", email, code: "", otpSentAt: sentAt, resendAvailableAt: sentAt + OTP_RESEND_COOLDOWN_MS, busy: "IDLE", error: null, resent: false });
  }

  /** Digits only, at most six (pasting a code with spaces works). */
  setCode(code: string): void {
    if (this.state.step !== "CODE" || this.state.busy !== "IDLE") return;
    this.set({ ...this.state, code: code.replace(/\D/g, "").slice(0, OTP_LENGTH), error: null });
  }

  canVerify(): boolean {
    return this.state.step === "CODE" && this.state.busy === "IDLE" && this.state.code.length === OTP_LENGTH;
  }

  async submitCode(): Promise<void> {
    const state = this.state;
    if (state.step !== "CODE" || !this.canVerify()) return;
    this.set({ ...state, busy: "VERIFYING", error: null });
    const result = await this.ports.signIn.verifyOtp(state.email, state.code, state.otpSentAt);
    if (this.state.step !== "CODE") return;
    if (result.ok) {
      this.set({ step: "SIGNED_IN" });
      return;
    }
    // A wrong code is cleared so the next attempt starts clean; other failures keep it for a retry.
    const keepCode = result.code !== "INVALID_OTP" && result.code !== "OTP_EXPIRED";
    this.set({ ...state, code: keepCode ? state.code : "", busy: "IDLE", error: result.code });
  }

  resendSecondsRemaining(): number {
    if (this.state.step !== "CODE") return 0;
    return Math.max(0, Math.ceil((this.state.resendAvailableAt - this.ports.now()) / 1000));
  }

  async resend(): Promise<void> {
    const state = this.state;
    if (state.step !== "CODE" || state.busy !== "IDLE" || this.resendSecondsRemaining() > 0) return;
    this.set({ ...state, busy: "RESENDING", error: null });
    const result = await this.ports.signIn.requestOtp(state.email);
    if (this.state.step !== "CODE") return;
    const now = this.ports.now();
    if (!result.ok) {
      // Even a refused resend restarts the cooldown: no hammering the email provider.
      this.set({ ...state, busy: "IDLE", error: result.code, resendAvailableAt: now + OTP_RESEND_COOLDOWN_MS });
      return;
    }
    this.set({ ...state, code: "", otpSentAt: now, resendAvailableAt: now + OTP_RESEND_COOLDOWN_MS, busy: "IDLE", error: null, resent: true });
  }

  changeEmail(): void {
    if (this.state.step !== "CODE" || this.state.busy !== "IDLE") return;
    this.set({ step: "EMAIL", email: this.state.email, sending: false, error: null });
  }

  private set(state: SignInState): void {
    this.state = state;
    this.onChange(state);
  }
}
