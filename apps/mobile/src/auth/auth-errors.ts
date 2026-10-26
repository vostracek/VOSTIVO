import { isAuthApiError, isAuthError, isAuthRetryableFetchError, isAuthSessionMissingError } from "@supabase/supabase-js";
import { SessionStorageUnavailableError } from "../identity/auth-session";

/**
 * Auth Slice C — the stable, application-level auth error vocabulary. Every
 * Supabase/SDK/storage failure is mapped into exactly one of these; the UI
 * only ever shows `authErrorCopy(code)`, never a raw message, status code or
 * stack trace.
 */
export type AuthErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "INVALID_EMAIL"
  | "INVALID_OTP"
  | "OTP_EXPIRED"
  | "RATE_LIMITED"
  | "SESSION_INVALID"
  | "STORAGE_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "UNKNOWN";

/** OTP lifetime configured on the Supabase project (6 digits, 600 s). */
export const OTP_LIFETIME_MS = 600_000;

export interface OtpVerificationContext {
  /** When the code being verified was requested (the latest send/resend). */
  readonly otpSentAt: number;
  readonly now: number;
}

const RATE_LIMIT_CODES = new Set(["over_request_rate_limit", "over_email_send_rate_limit", "over_sms_send_rate_limit"]);
const SESSION_INVALID_CODES = new Set(["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired", "bad_jwt", "user_not_found", "user_banned"]);
const INVALID_EMAIL_CODES = new Set(["email_address_invalid", "validation_failed", "email_address_not_authorized"]);
const CONFIGURATION_CODES = new Set(["email_provider_disabled", "otp_disabled", "signup_disabled", "provider_disabled"]);

/**
 * Maps anything thrown/returned by the auth layer. `otp_expired` is what
 * Supabase answers for BOTH a wrong and an expired code; it is reported as
 * `OTP_EXPIRED` only when the code is provably past its configured lifetime
 * (`context`), otherwise as `INVALID_OTP`.
 */
export function mapAuthError(error: unknown, context?: OtpVerificationContext): AuthErrorCode {
  if (error instanceof SessionStorageUnavailableError) return "STORAGE_UNAVAILABLE";
  if (!isAuthError(error)) return "UNKNOWN";
  if (isAuthRetryableFetchError(error)) return "NETWORK_UNAVAILABLE";
  if (isAuthSessionMissingError(error)) return "SESSION_INVALID";

  const code = error.code;
  if (error.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) return "RATE_LIMITED";
  if (code === "otp_expired") {
    return context !== undefined && context.now - context.otpSentAt >= OTP_LIFETIME_MS ? "OTP_EXPIRED" : "INVALID_OTP";
  }
  if (code !== undefined && SESSION_INVALID_CODES.has(code)) return "SESSION_INVALID";
  if (code !== undefined && INVALID_EMAIL_CODES.has(code)) return "INVALID_EMAIL";
  if (code !== undefined && CONFIGURATION_CODES.has(code)) return "CONFIGURATION_ERROR";
  // A 5xx from the auth server is a service problem, not a user mistake.
  if (isAuthApiError(error) && error.status >= 500) return "NETWORK_UNAVAILABLE";
  return "UNKNOWN";
}

/** Friendly, actionable copy — the only thing the athlete ever sees for an auth failure. */
export function authErrorCopy(code: AuthErrorCode): string {
  switch (code) {
    case "NETWORK_UNAVAILABLE":
      return "Can't reach Vostivo right now. Check your connection and try again.";
    case "INVALID_EMAIL":
      return "That email address doesn't look right.";
    case "INVALID_OTP":
      return "That code didn't work. Check the 6 digits and try again.";
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a moment, then try again.";
    case "SESSION_INVALID":
      return "Your session has ended. Sign in again.";
    case "STORAGE_UNAVAILABLE":
      return "This device couldn't store your sign-in securely. Try again.";
    case "CONFIGURATION_ERROR":
      return "Sign-in isn't available in this build.";
    case "UNKNOWN":
      return "Something went wrong. Try again.";
  }
}
