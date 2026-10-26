import { describe, expect, it } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { SessionStorageUnavailableError } from "../identity/auth-session";
import { authErrorCopy, mapAuthError, OTP_LIFETIME_MS, type AuthErrorCode } from "./auth-errors";

const SENT_AT = 1_000_000;

describe("mapAuthError — stable auth vocabulary", () => {
  it("AUTH-003: a wrong code (Supabase answers otp_expired for it too) inside the code's lifetime -> INVALID_OTP", () => {
    const error = new AuthApiError("Token has expired or is invalid", 403, "otp_expired");
    expect(mapAuthError(error, { otpSentAt: SENT_AT, now: SENT_AT + 30_000 })).toBe("INVALID_OTP");
    expect(mapAuthError(error)).toBe("INVALID_OTP");
  });

  it("AUTH-004: otp_expired once the configured 600 s lifetime has provably passed -> OTP_EXPIRED", () => {
    const error = new AuthApiError("Token has expired or is invalid", 403, "otp_expired");
    expect(mapAuthError(error, { otpSentAt: SENT_AT, now: SENT_AT + OTP_LIFETIME_MS })).toBe("OTP_EXPIRED");
  });

  it.each([
    ["429 status", new AuthApiError("too many", 429, undefined)],
    ["over_email_send_rate_limit", new AuthApiError("rate", 400, "over_email_send_rate_limit")],
    ["over_request_rate_limit", new AuthApiError("rate", 400, "over_request_rate_limit")],
  ])("AUTH-005: %s -> RATE_LIMITED", (_name, error) => {
    expect(mapAuthError(error)).toBe("RATE_LIMITED");
  });

  it("AUTH-019: a network failure is NETWORK_UNAVAILABLE, never SESSION_INVALID", () => {
    expect(mapAuthError(new AuthRetryableFetchError("Failed to fetch", 0))).toBe("NETWORK_UNAVAILABLE");
    expect(mapAuthError(new AuthApiError("upstream", 503, undefined))).toBe("NETWORK_UNAVAILABLE");
  });

  it("refused/revoked sessions -> SESSION_INVALID", () => {
    expect(mapAuthError(new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"))).toBe("SESSION_INVALID");
    expect(mapAuthError(new AuthSessionMissingError())).toBe("SESSION_INVALID");
  });

  it("storage, configuration, email and unknown failures", () => {
    expect(mapAuthError(new SessionStorageUnavailableError())).toBe("STORAGE_UNAVAILABLE");
    expect(mapAuthError(new AuthApiError("disabled", 422, "otp_disabled"))).toBe("CONFIGURATION_ERROR");
    expect(mapAuthError(new AuthApiError("bad", 400, "email_address_invalid"))).toBe("INVALID_EMAIL");
    expect(mapAuthError(new Error("boom"))).toBe("UNKNOWN");
    expect(mapAuthError("string")).toBe("UNKNOWN");
  });

  it("copy never echoes raw SDK messages and exists for every code", () => {
    const codes: AuthErrorCode[] = ["NETWORK_UNAVAILABLE", "INVALID_EMAIL", "INVALID_OTP", "OTP_EXPIRED", "RATE_LIMITED", "SESSION_INVALID", "STORAGE_UNAVAILABLE", "CONFIGURATION_ERROR", "UNKNOWN"];
    for (const code of codes) {
      const copy = authErrorCopy(code);
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/otp_|token|jwt|40\d|50\d/i);
    }
  });
});
