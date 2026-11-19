import { createContext, useContext } from "react";

/**
 * Auth Slice D — what the Account surface (Profile) may know and do about
 * the signed-in session. Provided by the IdentityGate's READY tree only; no
 * screen ever sees a token, a session object or the session source.
 */
export interface AccountCapabilities {
  /** How this build signs in: real email OTP, or a non-production developer token. */
  readonly signInMethod: "EMAIL_OTP" | "DEV_TOKEN";
  /** `false` for dev-token builds: there is no real sign-out to offer, so none is shown. */
  readonly signOutAvailable: boolean;
  /** The signed-in email (EMAIL_OTP only), or `null`. */
  readEmail(): Promise<string | null>;
  /** Disposes this owner's runtime, THEN signs out (see `IdentityGateController.signOut`). */
  signOut(): Promise<"SIGNED_OUT" | "FAILED">;
}

const AccountContext = createContext<AccountCapabilities | null>(null);

export const AccountProvider = AccountContext.Provider;

export function useAccount(): AccountCapabilities {
  const account = useContext(AccountContext);
  if (account === null) throw new Error("useAccount() used outside the IdentityGate READY tree");
  return account;
}
