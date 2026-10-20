import { createContext, useContext } from "react";
import type { AthleteRuntime } from "../plan/plan-runtime";

const AthleteRuntimeContext = createContext<AthleteRuntime | null>(null);

/**
 * Provides the ONE verified athlete's runtime to the screen tree. Rendered
 * only by the IdentityGate in its READY state, keyed by `userId`, so no
 * screen can exist without an owner and no screen state survives an owner
 * change.
 */
export function AthleteRuntimeProvider({ runtime, children }: { runtime: AthleteRuntime; children: React.ReactNode }): React.JSX.Element {
  return <AthleteRuntimeContext.Provider value={runtime}>{children}</AthleteRuntimeContext.Provider>;
}

/** The current owner's runtime. Throws outside the IdentityGate's READY tree — there is no fallback runtime. */
export function useAthleteRuntime(): AthleteRuntime {
  const runtime = useContext(AthleteRuntimeContext);
  if (runtime === null) throw new Error("useAthleteRuntime() used outside the IdentityGate READY tree");
  return runtime;
}
