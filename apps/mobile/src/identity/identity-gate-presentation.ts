import type { IdentityGateState, OwnedRuntime } from "./identity-gate-controller";

export interface IdentityGateCopy {
  readonly title: string;
  readonly body: string;
  /** `null` = no action (the gate is working). */
  readonly retryLabel: string | null;
}

/**
 * Calm, non-technical copy for every non-READY gate state. Never a raw
 * error, status code or token. `isDevBuild` only adds a developer hint
 * (e.g. "mint a new dev token") — it never changes what is allowed.
 */
export function identityGateCopy(state: Exclude<IdentityGateState<OwnedRuntime>, { status: "READY" }>, isDevBuild: boolean): IdentityGateCopy {
  switch (state.status) {
    case "BOOTING":
    case "VERIFYING":
      return { title: "Getting your training ready", body: "", retryLabel: null };
    case "NEEDS_NETWORK":
      return { title: "Connect once to verify this account", body: "This account hasn't been verified on this device yet. Connect to the internet and try again.", retryLabel: "Try again" };
    case "LOCAL_DATA_UNAVAILABLE":
      return {
        title: "Training data on this device can't be opened",
        body: "Nothing has been deleted. Your synced workouts are safe on the server.",
        retryLabel: "Try again",
      };
    case "SIGNED_OUT":
      return { title: "You're not signed in", body: isDevBuild ? "No sign-in is configured (EXPO_PUBLIC_SUPABASE_* or EXPO_PUBLIC_DEV_JWT / EXPO_PUBLIC_DEV_JWTS)." : "Sign in to continue.", retryLabel: null };
    case "REAUTH_REQUIRED":
      return { title: "Your session has ended", body: isDevBuild ? "The dev token was refused — mint a new one (auth:local:mint-jwt)." : "Please sign in again.", retryLabel: "Try again" };
    case "IDENTITY_ERROR":
      switch (state.reason) {
        case "BINDING_CONFLICT":
          return { title: "This account can't be opened here", body: "The account didn't match the one verified on this device before. Nothing has been changed.", retryLabel: null };
        case "SESSION_STORAGE_UNAVAILABLE":
          return { title: "Couldn't read your sign-in", body: "This device's secure storage isn't available right now. Nothing has been deleted.", retryLabel: "Try again" };
        case "INVALID_RESPONSE":
        case "UNEXPECTED":
          return { title: "Couldn't verify your account", body: "Nothing has been changed. Try again in a moment.", retryLabel: "Try again" };
      }
  }
}
