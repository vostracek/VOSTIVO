import type { PrescribedSetV1 } from "@vostivo/domain";
import type { RestTimerStateV1 } from "./active-workout-session";

/**
 * The one centralized fallback used when a prescribed set has no
 * `restSeconds` of its own (spec section 20 — "a temporary UI default may
 * be used only if clearly centralized/documented"). Never scattered as a
 * magic number elsewhere; every caller that needs a concrete rest
 * duration goes through `resolveRestDuration()` below.
 */
export const DEFAULT_REST_SECONDS = 90;

/**
 * Resolves the rest duration to start after completing a given prescribed
 * set — the prescription's own value when present, the centralized
 * default otherwise. Deliberately not a Training Engine optimization
 * decision (spec section 20) — a plain, explicit fallback.
 */
export function resolveRestDuration(prescribedSet: Pick<PrescribedSetV1, "restSeconds"> | undefined): number {
  return prescribedSet?.restSeconds ?? DEFAULT_REST_SECONDS;
}

/**
 * Pure derivation of remaining rest time (spec section 19/21) — always
 * `durationSeconds - elapsed`, never a value read from a ticking local
 * counter, so backgrounding/re-rendering/process-restart can never desync
 * it. Clamped to zero; never negative.
 */
export function computeRemainingSeconds(state: RestTimerStateV1, now: Date): number {
  const elapsedSeconds = Math.floor((now.getTime() - new Date(state.startedAt).getTime()) / 1000);
  return Math.max(0, state.durationSeconds - elapsedSeconds);
}

/** True once a rest timer has counted down to zero. */
export function isRestTimerFinished(state: RestTimerStateV1, now: Date): boolean {
  return computeRemainingSeconds(state, now) <= 0;
}
