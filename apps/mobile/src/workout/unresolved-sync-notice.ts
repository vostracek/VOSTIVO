import type { UnresolvedSyncSummary } from "./outbox-port";

/**
 * CC-03 — the athlete-visible "not synced yet" state on Today.
 *
 * Shown when any workout record cannot reach the server without attention:
 * BLOCKED (refused at request level, re-probed on the next app launch),
 * waiting behind a BLOCKED command, REJECTED or CONFLICT (the server's final
 * per-command outcomes), or a whole-request refusal of every probe (nothing
 * classified in the outbox — only the coordinator knows). Ordinary pending
 * commands (offline, retrying) are NOT included: they sync on their own.
 *
 * Calm and non-blocking: no action, because no in-app resolve/retry action
 * exists. Only BLOCKED (and what it holds) can recover by itself, through
 * the re-probe on a later app launch; REJECTED and CONFLICT are terminal
 * and are never re-sent, so they keep this notice visible. The absence of
 * the notice is never presented as "all synced".
 */
export interface UnresolvedSyncNotice {
  readonly message: string;
}

export const UNRESOLVED_SYNC_MESSAGE = "Some workout records haven't synced yet. They're saved on this device.";

export function unresolvedSyncNotice(summary: UnresolvedSyncSummary, requestRejected: boolean): UnresolvedSyncNotice | null {
  const unresolved = summary.blocked + summary.waitingOnBlocked + summary.rejected + summary.conflicted;
  return unresolved > 0 || requestRejected ? { message: UNRESOLVED_SYNC_MESSAGE } : null;
}

export interface UnresolvedSyncPorts {
  readSummary(): Promise<UnresolvedSyncSummary>;
  isRequestRejected(): boolean;
  /** Called after every settled sync pass; returns an unsubscribe. */
  onSyncPassSettled(listener: () => void): () => void;
}

/**
 * Framework-free controller behind Today's notice: reads once on `start`,
 * again after every settled sync pass (mutation, launch, foreground resume,
 * network regain, retry) and on explicit `refresh` (screen focus). A failed
 * read keeps the last known notice — it never flips to "nothing unresolved"
 * without evidence. Out-of-order reads cannot overwrite a newer one.
 */
export class UnresolvedSyncMonitor {
  private unsubscribe: (() => void) | undefined;
  private latestRead = 0;
  private disposed = false;

  constructor(
    private readonly ports: UnresolvedSyncPorts,
    private readonly onChange: (notice: UnresolvedSyncNotice | null) => void,
    private readonly logFailure: (message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.disposed || this.unsubscribe !== undefined) return;
    this.unsubscribe = this.ports.onSyncPassSettled(() => void this.refresh());
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const read = ++this.latestRead;
    try {
      const summary = await this.ports.readSummary();
      if (this.disposed || read !== this.latestRead) return;
      this.onChange(unresolvedSyncNotice(summary, this.ports.isRequestRejected()));
    } catch {
      this.logFailure("unresolved sync state read failed");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
