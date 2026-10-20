import { isSameSessionIdentity, type AuthSession, type AuthSessionSource } from "./auth-session";
import type { VerifiedIdentity } from "./identity-binding-store";
import type { IdentityErrorReason, IdentityResolution } from "./identity-resolution";
import type { LocalDataUnavailableReason } from "../local-database/athlete-database";

/** What the gate needs from an athlete runtime: who owns it and how to tear it down. */
export interface OwnedRuntime {
  readonly ownerUserId: string;
  dispose(): Promise<void>;
}

export type IdentityGateState<Runtime extends OwnedRuntime> =
  | { readonly status: "BOOTING" }
  /** Resolving an identity or switching owners — a neutral screen, never any athlete data. */
  | { readonly status: "VERIFYING" }
  /** Unknown provider subject and no network: no athlete database is opened. */
  | { readonly status: "NEEDS_NETWORK" }
  /** The owner's database exists but cannot be opened (key missing/invalid/wrong) — never wiped. */
  | { readonly status: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason }
  | { readonly status: "IDENTITY_ERROR"; readonly reason: IdentityErrorReason }
  /** The ONLY state under which athlete UI exists. */
  | {
      readonly status: "READY";
      readonly identity: VerifiedIdentity;
      readonly verification: "ONLINE" | "OFFLINE_BINDING";
      readonly runtime: Runtime;
    };

export type OpenRuntimeResult<Runtime> = { readonly kind: "OPENED"; readonly runtime: Runtime } | { readonly kind: "LOCAL_DATA_UNAVAILABLE"; readonly reason: LocalDataUnavailableReason };

export interface IdentityGatePorts<Runtime extends OwnedRuntime> {
  readonly sessionSource: AuthSessionSource;
  resolveIdentity(session: AuthSession): Promise<IdentityResolution>;
  /** Opens the owner's own database and builds the runtime bound to it and to `session`'s provider identity. */
  openRuntime(identity: VerifiedIdentity, session: AuthSession): Promise<OpenRuntimeResult<Runtime>>;
  onStateChange(state: IdentityGateState<Runtime>): void;
}

interface ActiveOwner<Runtime> {
  readonly session: Pick<AuthSession, "provider" | "providerSubject">;
  readonly identity: VerifiedIdentity;
  readonly verification: "ONLINE" | "OFFLINE_BINDING";
  readonly runtime: Runtime;
}

/**
 * Auth & Local Athlete Boundary V1 Slice B — the IdentityGate state machine
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
 * (AUTH-LOCAL-003); `/me` is re-checked and only a refusal or a conflicting
 * binding tears it down (fail closed).
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
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly ports: IdentityGatePorts<Runtime>) {}

  start(): void {
    this.ports.onStateChange({ status: "BOOTING" });
    this.unsubscribe = this.ports.sessionSource.subscribe(() => this.reevaluate());
    this.reevaluate();
  }

  /** Re-runs resolution (e.g. "Try again" from NEEDS_NETWORK / an error state). */
  reevaluate(): Promise<void> {
    const ticket = ++this.requested;
    this.queue = this.queue.then(() => this.evaluate(ticket)).catch(() => this.publish({ status: "IDENTITY_ERROR", reason: "UNEXPECTED" }));
    return this.queue;
  }

  /** Unsubscribes and disposes the current runtime (awaited). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.requested += 1;
    await this.queue;
    await this.detachAndDispose();
  }

  private async evaluate(ticket: number): Promise<void> {
    const isSuperseded = () => this.stopped || ticket !== this.requested;
    if (isSuperseded()) return;

    const session = await this.ports.sessionSource.getSession();
    if (isSuperseded()) return;

    const current = this.active;
    if (current !== undefined && session !== null && isSameSessionIdentity(current.session, session)) {
      await this.reverifySameIdentity(current, session, isSuperseded);
      return;
    }

    // Identity changed (or is gone): A leaves BEFORE anything of B is resolved or opened.
    await this.detachAndDispose();
    if (isSuperseded()) return;

    if (session === null) {
      this.publish({ status: "IDENTITY_ERROR", reason: "NO_SESSION" });
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
      this.publish({ status: "IDENTITY_ERROR", reason: resolution.reason });
      return;
    }

    const opened = await this.ports.openRuntime(resolution.identity, session);
    if (opened.kind === "LOCAL_DATA_UNAVAILABLE") {
      if (!isSuperseded()) this.publish({ status: "LOCAL_DATA_UNAVAILABLE", reason: opened.reason });
      return;
    }
    if (isSuperseded() || opened.runtime.ownerUserId !== resolution.identity.userId) {
      await opened.runtime.dispose();
      return;
    }

    this.active = { session: { provider: session.provider, providerSubject: session.providerSubject }, identity: resolution.identity, verification: resolution.source, runtime: opened.runtime };
    this.publishActive(this.active);
  }

  /**
   * Same provider identity, possibly a new token. The runtime stays mounted
   * and keeps working (its token provider already picks up the new token).
   * Only the server refusing the token or the subject now resolving to
   * another user ends it — fail closed, nothing deleted.
   */
  private async reverifySameIdentity(current: ActiveOwner<Runtime>, session: AuthSession, isSuperseded: () => boolean): Promise<void> {
    const resolution = await this.ports.resolveIdentity(session);
    if (isSuperseded() || this.active !== current) return;

    if (resolution.kind === "VERIFIED") {
      if (resolution.identity.userId === current.identity.userId) {
        if (resolution.source === "ONLINE" && current.verification !== "ONLINE") {
          this.active = { ...current, verification: "ONLINE" };
          this.publishActive(this.active);
        }
        return;
      }
      await this.detachAndDispose();
      this.publish({ status: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
      return;
    }
    // Offline right now: the already verified owner simply continues.
    if (resolution.kind === "NEEDS_NETWORK") return;

    await this.detachAndDispose();
    this.publish({ status: "IDENTITY_ERROR", reason: resolution.reason });
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
    this.publish({ status: "READY", identity: active.identity, verification: active.verification, runtime: active.runtime });
  }

  private publish(state: IdentityGateState<Runtime>): void {
    if (this.stopped) return;
    this.ports.onStateChange(state);
  }
}
