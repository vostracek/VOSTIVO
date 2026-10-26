import { createContext, useContext } from "react";
import type { AthleteRuntime } from "../plan/plan-runtime";

const AthleteRuntimeContext = createContext<AthleteRuntime | null>(null);
const AuthRecoveryCountContext = createContext(0);

/**
 * Provides the ONE verified athlete's runtime to the screen tree. Rendered
 * only by the IdentityGate in its READY state, keyed by `userId`, so no
 * screen can exist without an owner and no screen state survives an owner
 * change. `authRecoveries` counts this owner's re-authentications
 * (`nextAuthRecoveryCount`).
 */
export function AthleteRuntimeProvider({
  runtime,
  authRecoveries = 0,
  children,
}: {
  runtime: AthleteRuntime;
  authRecoveries?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <AthleteRuntimeContext.Provider value={runtime}>
      <AuthRecoveryCountContext.Provider value={authRecoveries}>{children}</AuthRecoveryCountContext.Provider>
    </AthleteRuntimeContext.Provider>
  );
}

/** The current owner's runtime. Throws outside the IdentityGate's READY tree — there is no fallback runtime. */
export function useAthleteRuntime(): AthleteRuntime {
  const runtime = useContext(AthleteRuntimeContext);
  if (runtime === null) throw new Error("useAthleteRuntime() used outside the IdentityGate READY tree");
  return runtime;
}

/** Auth Slice C: increments each time the owner's session comes back after re-auth — a dependency for screens that must reload then. */
export function useAuthRecoveryCount(): number {
  return useContext(AuthRecoveryCountContext);
}
