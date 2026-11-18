/**
 * ANDROID-STAB-03 D1: Finish Workout runs at most once per session from a
 * single screen. React state cannot close the double-tap race — a second
 * press is delivered before the re-render that leaves the "active" state —
 * so the claim is taken synchronously in the press handler (the same
 * reasoning as CORE-FIX-11's `in-flight-guard.ts`).
 *
 * Unlike a plain in-flight guard, a SUCCESSFUL finish keeps its key
 * claimed: a late second tap must not re-run Finish, whose repository
 * answer would be `ALREADY_FINISHED` and would replace the just-shown
 * completion summary with "No active workout". A failed attempt (thrown
 * error) releases the key so the athlete can try again.
 *
 * Defense in depth only: the repository's local terminal invariant and the
 * server's FINISH idempotency remain the data authorities.
 */
export interface FinishGuard {
  /** Runs `action` unless this key is in flight or already finished; returns whether it ran. */
  run(key: string, action: () => Promise<void>): Promise<boolean>;
  isClaimed(key: string): boolean;
}

export function createFinishGuard(): FinishGuard {
  const inFlight = new Set<string>();
  const finished = new Set<string>();
  return {
    async run(key, action) {
      if (inFlight.has(key) || finished.has(key)) return false;
      inFlight.add(key);
      try {
        await action();
        finished.add(key);
        return true;
      } finally {
        inFlight.delete(key);
      }
    },
    isClaimed: (key) => inFlight.has(key) || finished.has(key),
  };
}
