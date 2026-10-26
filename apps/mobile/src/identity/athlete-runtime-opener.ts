import { createAthleteRuntime, type AthleteRuntime } from "../plan/plan-runtime";
import type { WorkoutSyncLogger } from "../infrastructure/workout-sync-coordinator";
import type { WorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import type { AthleteDatabaseHandle } from "../local-database/athlete-database-handle";
import type { OpenAthleteDatabaseResult } from "../local-database/athlete-database";
import type { AuthSession, AuthSessionSource } from "./auth-session";
import type { VerifiedIdentity } from "./identity-binding-store";
import type { OpenRuntimeResult, OwnerVerification } from "./identity-gate-controller";
import { OwnerBoundAuthTokenProvider } from "./owner-bound-auth-token-provider";

export interface AthleteRuntimeOpenerDeps {
  readonly sessionSource: AuthSessionSource;
  readonly apiBaseUrl: string;
  /** The verified owner's OWN database — `openNativeAthleteDatabase` in the app. */
  openDatabase(userId: string): Promise<OpenAthleteDatabaseResult<AthleteDatabaseHandle>>;
  readonly workoutSyncApiClient?: WorkoutSyncApiClient;
  readonly syncLogger?: WorkoutSyncLogger;
  /** Auth Slice C: a request found this owner's session unusable — the gate re-evaluates (sync paused, re-auth asked; the runtime stays). */
  readonly onSessionInvalid?: () => void;
}

/**
 * The IdentityGate's `openRuntime` step: open the verified owner's database,
 * then build the runtime bound to that owner — its `ownerUserId`, its
 * database handle, and a token provider bound to the session's provider
 * identity. Outbox sync starts permitted only for an owner verified ONLINE
 * just now (Slice C). Shared by the app and the isolation tests.
 */
export function createAthleteRuntimeOpener(
  deps: AthleteRuntimeOpenerDeps,
): (identity: VerifiedIdentity, session: AuthSession, verification: OwnerVerification) => Promise<OpenRuntimeResult<AthleteRuntime>> {
  return async (identity, session, verification) => {
    const opened = await deps.openDatabase(identity.userId);
    if (opened.kind === "LOCAL_DATA_UNAVAILABLE") return opened;
    const runtime = createAthleteRuntime({
      ownerUserId: identity.userId,
      database: opened.handle,
      authTokenProvider: new OwnerBoundAuthTokenProvider(deps.sessionSource, { provider: session.provider, providerSubject: session.providerSubject }, deps.onSessionInvalid),
      apiBaseUrl: deps.apiBaseUrl,
      syncPermitted: verification === "ONLINE",
      workoutSyncApiClient: deps.workoutSyncApiClient,
      syncLogger: deps.syncLogger,
    });
    return { kind: "OPENED", runtime };
  };
}
