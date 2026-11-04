/**
 * CORE-FIX-11 (F-11): a synchronous per-key in-flight guard for Active
 * Workout set actions (LOG SET / ✓ / reopen). React state cannot close this
 * race: a second tap can be delivered before the re-render that would
 * disable the control, so membership is tracked in a plain Set owned by a
 * ref and checked/claimed synchronously in the press handler. Keys are per
 * planned set slot, so logging one set never blocks another. The key is
 * always released when the action settles — success, typed outcome or
 * thrown error — so nothing stays locked after a failure or navigation.
 * Defense in depth only: the repository's own transaction is the identity
 * authority (`WorkoutRepository.completeSet`).
 */
export interface InFlightGuard {
  /** Runs `action` unless the same key is already running; returns whether it ran. */
  run(key: string, action: () => Promise<void>): Promise<boolean>;
  isInFlight(key: string): boolean;
}

export function createInFlightGuard(): InFlightGuard {
  const inFlight = new Set<string>();
  return {
    async run(key, action) {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      try {
        await action();
        return true;
      } finally {
        inFlight.delete(key);
      }
    },
    isInFlight: (key) => inFlight.has(key),
  };
}

/** The guard key of one planned set slot (unplanned sets have no slot and are keyed by their row). */
export function setActionKey(prescriptionExerciseId: string | null, slotOrRowId: string): string {
  return `${prescriptionExerciseId ?? "unplanned"}:${slotOrRowId}`;
}
