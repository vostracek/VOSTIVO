import { isSameSessionIdentity, SessionStorageUnavailableError, type AuthSession, type AuthSessionSource } from "./auth-session";
import type { VerifiedIdentity } from "./identity-binding-store";
import type { IdentityResolution } from "./identity-resolution";
import type { LocalDataUnavailableReason } from "../local-database/athlete-database";
import type { AppLifecycleSource, ConnectivitySource } from "../infrastructure/sync-recovery";

/** What the gate needs from an athlete runtime: who owns it, whether it may sync, and how to tear it down. */
export interface OwnedRuntime {
  readonly ownerUserId: string;
  /** Auth Slice C: outbox sync only while the owner is verified online with a valid session. */
  setSyncPermitted(permitted: boolean): void;
  dispose(): Promise<void>;
}

export type IdentityGateErrorReason =
  /** The same provider subject resolved to a different user than the verified binding. */
  | "BINDING_CONFLICT"
  /** The server answered, but not with a usable identity. */
  | "INVALID_RESPONSE"
  /** The secure session store could not be read (typed storage failure — nothing deleted). */
  | "SESSION_STORAGE_UNAVAILABLE"
  /** Something failed while resolving/opening (a bug or a native failure) — fail closed. */
  | "UNEXPECTED";

/** How the READY owner was last verified: authenticated `/me` now, or only its stored verified binding (offline boot / unverifiable). */
export type OwnerVerification = "ONLINE" | "OFFLINE_BINDING";

export type IdentityGateState<Runtime extends OwnedRuntime> =
  | { readonly status: "BOOTING" }
  /** Resolving an identity or switching owners — a neutral screen, never any athlete data. */
  | { readonly status: "VERIFYING" }
  /** No session: the sign-in surface (email OTP), no athlete database open. */
  | { readonly status: "SIGNED_OUT" }
  /** Auth Slice C: the session stopped being valid and no athlete runtime is open — sign in again. Never conflated with NEEDS_NETWORK. */
  | { readonly status: "REAUTH_REQUIRED" }
  /** Unknown provider subject and no network: no athlete database is opened. */
  | { readonly status: "NEEDS_NETWORK" }
  /** The owner's database exists but cannot be opened (key missing/invalid/wrong) — never wiped. */
  | { readonly status: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason }
  | { readonly status: "IDENTITY_ERROR"; readonly reason: IdentityGateErrorReason }
  /**
   * The ONLY state under which athlete UI exists. `auth: "REAUTH_REQUIRED"`
   * keeps the owner's runtime (and an active workout) fully usable locally
   * while sync is paused until the SAME owner signs in again.
   */
  | {
      readonly status: "READY";
      readonly identity: VerifiedIdentity;
      readonly verification: OwnerVerification;
      readonly auth: "VALID" | "REAUTH_REQUIRED";
      readonly runtime: Runtime;
    };

export type OpenRuntimeResult<Runtime> = { readonly kind: "OPENED"; readonly runtime: Runtime } | { readonly kind: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason };

export interface IdentityGatePorts<Runtime extends OwnedRuntime> {
  readonly sessionSource: AuthSessionSource;
  resolveIdentity(session: AuthSession): Promise<IdentityResolution>;
  /** Opens the owner's own database and builds the runtime bound to it and to `session`'s provider identity; sync is permitted only for an ONLINE verification. */
  openRuntime(identity: VerifiedIdentity, session: AuthSession, verification: OwnerVerification): Promise<OpenRuntimeResult<Runtime>>;
  onStateChange(state: IdentityGateState<Runtime>): void;
  /** Network regain re-verifies an owner that is not verified online yet (Slice C). */
  readonly connectivity?: ConnectivitySource;
  /** Foreground re-verifies an owner that is not verified online yet (Slice C). */
  readonly appLifecycle?: AppLifecycleSource;
}

interface ActiveOwner<Runtime> {
  readonly session: Pick<AuthSession, "provider" | "providerSubject">;
  readonly identity: VerifiedIdentity;
  readonly verification: OwnerVerification;
  readonly auth: "VALID" | "REAUTH_REQUIRED";
  readonly runtime: Runtime;
}

/**
 * Auth & Local Athlete Boundary V1 — the IdentityGate state machine
 * (framework-free; `identity-gate.tsx` renders it).
 *
 *   session -> verified identity (`/me`, or a verified binding offline) ->
 *   open THAT user's database -> build THAT user's runtime -> READY
 *
 * Identity transition (A -> B), in this order, with the screen tree
 * unmounted for the whole of it: A's runtime is detached (state VERIFYING —
 * no athlete UI), A is disposed (sync stopped, database closed — awaited),
 * B is resolved/verified, B's database opened, B's runtime built, READY(B).
 * Nothing is moved, copied or deleted at any step, so a crash anywhere just
 * re-runs this from the start (AUTH-LOCAL-009).
 *
 * A new token for the SAME provider identity is not a transition: the
 * runtime, its database and any active workout stay exactly as they are
 * (AUTH-LOCAL-003); `/me` is re-checked and only a conflicting binding
 * tears it down (fail closed).
 *
 * Auth Slice C:
 * - Sync is permitted only while the owner is verified ONLINE with a valid
 *   session. An offline-bound boot opens the owner's data but keeps the
 *   outbox on the device until network regain/foreground re-verifies the
 *   same `userId` through `/me`.
 * - An invalid session (refresh refused, revoked, `/me` 401 after one
 *   refresh) NEVER closes the current owner's runtime: READY keeps it with
 *   `auth: REAUTH_REQUIRED` and sync paused. Re-authenticating as the SAME
 *   subject resumes sync; another subject is an ordinary A -> B transition.
 * - Only an explicit sign-out (session gone with loss `SIGNED_OUT`) disposes
 *   the runtime without a successor.
 *
 * Evaluations are serialized (one at a time — a database is never opened
 * while another is still closing) and superseded ones abandon their work,
 * disposing anything they built.
 */
export class IdentityGateController<Runtime extends OwnedRuntime> {
  private active: ActiveOwner<Runtime> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private requested = 0;
  private stopped = false;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly ports: IdentityGatePorts<Runtime>) {}

  start(): void {
    this.ports.onStateChange({ status: "BOOTING" });
    this.unsubscribers.push(this.ports.sessionSource.subscribe(() => void this.reevaluate()));
    let wasConnected: boolean | undefined;
    const connectivity = this.ports.connectivity?.subscribe((isConnected) => {
      const regained = isConnected && wasConnected === false;
      wasConnected = isConnected;
      if (regained && this.needsOnlineVerification()) void this.reevaluate();
    });
    if (connectivity !== undefined) this.unsubscribers.push(connectivity);
    const lifecycle = this.ports.appLifecycle?.subscribe((state) => {
      if (state === "active" && this.needsOnlineVerification()) void this.reevaluate();
    });
    if (lifecycle !== undefined) this.unsubscribers.push(lifecycle);
    void this.reevaluate();
  }

  /** Re-runs resolution (e.g. "Try again", a reported invalid session). */
  reevaluate(): Promise<void> {
    const ticket = ++this.requested;
    this.queue = this.queue.then(() => this.evaluate(ticket)).catch(() => this.publish({ status: "IDENTITY_ERROR", reason: "UNEXPECTED" }));
    return this.queue;
  }

  /** Unsubscribes and disposes the current runtime (awaited). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.requested += 1;
    await this.queue;
    await this.detachAndDispose();
  }

  private needsOnlineVerification(): boolean {
    return this.active !== undefined && this.active.verification !== "ONLINE";
  }

  private async evaluate(ticket: number): Promise<void> {
    const isSuperseded = () => this.stopped || ticket !== this.requested;
    if (isSuperseded()) return;

    let session: AuthSession | null;
    try {
      session = await this.ports.sessionSource.getSession();
    } catch (error) {
      if (!(error instanceof SessionStorageUnavailableError)) throw error;
      if (isSuperseded()) return;
      // A storage failure is not an identity change: an open owner keeps
      // working locally with sync paused; nothing is ever deleted.
      if (this.active !== undefined) {
        this.update(this.active, { verification: "OFFLINE_BINDING" });
        return;
      }
      this.publish({ status: "IDENTITY_ERROR", reason: "SESSION_STORAGE_UNAVAILABLE" });
      return;
    }
    if (isSuperseded()) return;

    const current = this.active;
    if (current !== undefined && session !== null && isSameSessionIdentity(current.session, session)) {
      await this.reverifySameIdentity(current, session, isSuperseded);
      return;
    }
    const loss = session === null ? (this.ports.sessionSource.sessionLoss?.() ?? "SIGNED_OUT") : undefined;
    if (current !== undefined && loss === "SESSION_INVALID") {
      // Revoked/expired session of the open owner: keep the runtime (an
      // active workout must survive), pause sync, ask for sign-in.
      this.update(current, { auth: "REAUTH_REQUIRED" });
      return;
    }

    // Identity changed (or explicitly signed out): A leaves BEFORE anything of B is resolved or opened.
    await this.detachAndDispose();
    if (isSuperseded()) return;

    if (session === null) {
      this.publish(loss === "SESSION_INVALID" ? { status: "REAUTH_REQUIRED" } : { status: "SIGNED_OUT" });
      return;
    }

    this.publish({ status: "VERIFYING" });
    const resolution = await this.ports.resolveIdentity(session);
    if (isSuperseded()) return;
    if (resolution.kind === "NEEDS_NETWORK") {
      this.publish({ status: "NEEDS_NETWORK" });
      return;
    }
    if (resolution.kind === "IDENTITY_ERROR") {
      this.publish(resolution.reason === "UNAUTHORIZED" ? { status: "REAUTH_REQUIRED" } : { status: "IDENTITY_ERROR", reason: resolution.reason });
      return;
    }

    const opened = await this.ports.openRuntime(resolution.identity, session, resolution.source);
    if (opened.kind === "LOCAL_DATA_UNAVAILABLE") {
      if (!isSuperseded()) this.publish({ status: "LOCAL_DATA_UNAVAILABLE", reason: opened.reason });
      return;
    }
    if (isSuperseded() || opened.runtime.ownerUserId !== resolution.identity.userId) {
      await opened.runtime.dispose();
      return;
    }

    this.active = {
      session: { provider: session.provider, providerSubject: session.providerSubject },
      identity: resolution.identity,
      verification: resolution.source,
      auth: "VALID",
      runtime: opened.runtime,
    };
    this.publishActive(this.active);
  }

  /**
   * Same provider identity, possibly a new token. The runtime stays mounted
   * and keeps working (its token provider already picks up the new token).
   * `/me` confirming the same `userId` online (re-)grants sync; a refusal
   * only pauses sync (re-auth); the subject resolving to another user ends
   * it — fail closed, nothing deleted.
   */
  private async reverifySameIdentity(current: ActiveOwner<Runtime>, session: AuthSession, isSuperseded: () => boolean): Promise<void> {
    const resolution = await this.ports.resolveIdentity(session);
    if (isSuperseded() || this.active !== current) return;

    switch (resolution.kind) {
      case "VERIFIED":
        if (resolution.identity.userId !== current.identity.userId) {
          await this.detachAndDispose();
          this.publish({ status: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
          return;
        }
        // Offline right now: the already verified owner simply continues as it is.
        if (resolution.source === "ONLINE") this.update(current, { verification: "ONLINE", auth: "VALID" });
        return;
      case "NEEDS_NETWORK":
        return;
      case "IDENTITY_ERROR":
        if (resolution.reason === "BINDING_CONFLICT") {
          // The subject now maps to another user than the open owner: fail closed (Slice B), nothing deleted.
          await this.detachAndDispose();
          this.publish({ status: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
        } else if (resolution.reason === "UNAUTHORIZED") {
          this.update(current, { auth: "REAUTH_REQUIRED" });
        } else {
          // Not a trustworthy answer: keep the owner's local data, but no sync until `/me` verifies again.
          this.update(current, { verification: "OFFLINE_BINDING" });
        }
        return;
    }
  }

  private update(current: ActiveOwner<Runtime>, patch: Partial<Pick<ActiveOwner<Runtime>, "verification" | "auth">>): void {
    const next: ActiveOwner<Runtime> = { ...current, ...patch };
    if (next.verification === current.verification && next.auth === current.auth) return;
    this.active = next;
    next.runtime.setSyncPermitted(isSyncPermitted(next));
    this.publishActive(next);
  }

  /** Detach first (the tree unmounts on VERIFYING), then dispose — awaited, so the database is closed before anything else opens. */
  private async detachAndDispose(): Promise<void> {
    const current = this.active;
    if (current === undefined) return;
    this.active = undefined;
    this.publish({ status: "VERIFYING" });
    await current.runtime.dispose();
  }

  private publishActive(active: ActiveOwner<Runtime>): void {
    this.publish({ status: "READY", identity: active.identity, verification: active.verification, auth: active.auth, runtime: active.runtime });
  }

  private publish(state: IdentityGateState<Runtime>): void {
    if (this.stopped) return;
    this.ports.onStateChange(state);
  }
}

export function isSyncPermitted(owner: Pick<ActiveOwner<unknown>, "verification" | "auth">): boolean {
  return owner.verification === "ONLINE" && owner.auth === "VALID";
}
