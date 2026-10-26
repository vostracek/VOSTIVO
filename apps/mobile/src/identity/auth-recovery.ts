export type ReadyAuthStatus = "VALID" | "REAUTH_REQUIRED";

/**
 * Auth Slice C — counts re-authentications of the current owner: each
 * `REAUTH_REQUIRED -> VALID` transition (the same owner signed in again and
 * `/me` re-verified them) bumps the count. Screens that loaded while the
 * session was gone use it to reload once the session is back, instead of
 * keeping a stale "sign in again" error on screen.
 */
export function nextAuthRecoveryCount(previous: ReadyAuthStatus | null, next: ReadyAuthStatus | null, count: number): number {
  return previous === "REAUTH_REQUIRED" && next === "VALID" ? count + 1 : count;
}
