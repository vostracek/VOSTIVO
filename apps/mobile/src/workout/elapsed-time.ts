/**
 * Elapsed workout duration is always derived as `now - startedAt` (spec
 * section 6) — never a persisted/ticking counter, so backgrounding or a
 * re-render can never reset or desync it.
 */
export function computeElapsedSeconds(startedAtIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(startedAtIso).getTime()) / 1000));
}

/** `MM:SS` below one hour, `H:MM:SS` at or above it — compact enough for a header. */
export function formatElapsedDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
