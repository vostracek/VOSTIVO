import type { SetDraftV1 } from "./active-workout-session";

/**
 * ANDROID-STAB-03 D2: the in-memory twin of `WorkoutRepository.saveSetDraft`.
 *
 * Active Workout renders drafts from the `session.drafts` snapshot of its
 * last `loadSession()`. A draft typed after that snapshot was persisted to
 * SQLite but was missing in memory, so switching exercises (which remounts
 * every `SetRow` and re-derives its prefill) showed the untouched planned
 * value instead of the athlete's input — until a process restart reloaded
 * the drafts. The screen now applies every saved draft to its snapshot with
 * this function, keyed exactly like the repository row: one draft per
 * (prescriptionExerciseId, prescriptionSetId), so values never leak between
 * exercises or sets. A draft never completes a set; completed reality still
 * wins over a draft in `resolvePrefill`.
 */
export function upsertSetDraft(
  drafts: readonly SetDraftV1[],
  draft: SetDraftV1,
): readonly SetDraftV1[] {
  const sameSlot = (candidate: SetDraftV1) =>
    candidate.prescriptionExerciseId === draft.prescriptionExerciseId &&
    candidate.prescriptionSetId === draft.prescriptionSetId;
  return drafts.some(sameSlot)
    ? drafts.map((candidate) => (sameSlot(candidate) ? draft : candidate))
    : [...drafts, draft];
}

/** Timer boundary, injected so tests drive the debounce without real waits. */
export interface DraftScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: DraftScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The ~400 ms debounced auto-save of one set row's draft (Active Workout final review pass). */
export const SET_DRAFT_DEBOUNCE_MS = 400;

export interface DraftDebouncer {
  /** A keystroke: (re)start the debounce window. */
  schedule(): void;
  /** Blur: save now (cancels a pending window). */
  flush(): void;
  /**
   * Unmount (exercise switch, navigation): save a still-pending draft instead
   * of dropping it (D2), then stop. Nothing pending -> nothing saved.
   */
  dispose(): void;
}

export function createDraftDebouncer(
  save: () => void,
  delayMs = SET_DRAFT_DEBOUNCE_MS,
  scheduler: DraftScheduler = realScheduler,
): DraftDebouncer {
  let handle: unknown = undefined;
  let pending = false;
  let disposed = false;

  const cancel = () => {
    if (pending) scheduler.clearTimeout(handle);
    handle = undefined;
    pending = false;
  };

  return {
    schedule() {
      if (disposed) return;
      cancel();
      pending = true;
      handle = scheduler.setTimeout(() => {
        handle = undefined;
        pending = false;
        save();
      }, delayMs);
    },
    flush() {
      if (disposed) return;
      cancel();
      save();
    },
    dispose() {
      if (disposed) return;
      const hadPending = pending;
      cancel();
      disposed = true;
      if (hadPending) save();
    },
  };
}
