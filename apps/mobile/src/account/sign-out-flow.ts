/**
 * Auth & Local Athlete Boundary V1 — Slice D: the pre-sign-out check
 * (AUTH-LOCAL-BOUNDARY §10). Framework-free and unit-tested.
 *
 *   count the owner's unsynced work (outbox PENDING / RETRY / SYNCING /
 *   BLOCKED + an ACTIVE workout)
 *     zero     -> CLEAR (sign out right away)
 *     non-zero -> one bounded sync pass (default 10 s), count again
 *                 still non-zero -> UNSYNCED (calm confirmation)
 *
 * Nothing here deletes, rewrites or re-owns local data — signing out only
 * closes this owner's database; the same athlete signing back in reopens it
 * and the outbox syncs as that athlete (§7).
 */
export interface UnsyncedWork {
  readonly pendingCommands: number;
  readonly hasActiveWorkout: boolean;
}

export interface SignOutCheckPorts {
  readUnsyncedWork(): Promise<UnsyncedWork>;
  requestSync(): void;
  /** Resolves on the next settled sync pass; returns an unsubscribe. */
  onSyncPassSettled(listener: () => void): () => void;
}

export type SignOutCheck = { readonly kind: "CLEAR" } | { readonly kind: "UNSYNCED"; readonly work: UnsyncedWork };

export const SIGN_OUT_SYNC_TIMEOUT_MS = 10_000;

export const SIGN_OUT_COPY = {
  action: "Sign out",
  checking: "Checking your workouts…",
  signingOut: "Signing out…",
  unsyncedTitle: "Your workout hasn't synced yet.",
  unsyncedBody: "It stays safely on this phone and finishes syncing the next time you sign in.",
  activeWorkoutBody: "Your workout in progress stays on this phone. Sign back in to continue it.",
  stay: "Stay signed in",
  confirm: "Sign out",
  failed: "Couldn't sign out. Your data is safe on this phone — try again.",
} as const;

function hasWork(work: UnsyncedWork): boolean {
  return work.pendingCommands > 0 || work.hasActiveWorkout;
}

export async function checkBeforeSignOut(
  ports: SignOutCheckPorts,
  waitForPass: (ports: SignOutCheckPorts) => Promise<void> = (p) => waitForSyncPass(p, SIGN_OUT_SYNC_TIMEOUT_MS),
): Promise<SignOutCheck> {
  const first = await ports.readUnsyncedWork();
  if (!hasWork(first)) return { kind: "CLEAR" };
  // An ACTIVE workout cannot be synced away — only pending commands can.
  if (first.pendingCommands > 0) await waitForPass(ports);
  const after = first.pendingCommands > 0 ? await ports.readUnsyncedWork() : first;
  return hasWork(after) ? { kind: "UNSYNCED", work: after } : { kind: "CLEAR" };
}

/** Requests one sync pass and waits for it to settle, at most `timeoutMs` (offline never blocks sign-out). */
export function waitForSyncPass(ports: SignOutCheckPorts, timeoutMs: number, schedule: typeof setTimeout = setTimeout): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = ports.onSyncPassSettled(finish);
    const timer = schedule(finish, timeoutMs);
    ports.requestSync();
  });
}
