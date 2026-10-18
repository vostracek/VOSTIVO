import type { WorkoutSyncTrigger } from "./workout-sync-coordinator";

/**
 * Matches React Native's `AppStateStatus` values exactly, without this
 * file importing `react-native` — kept framework-agnostic the same way
 * `OutboxPort` keeps `SyncEngine` free of SQLite (see
 * src/workout/outbox-port.ts). `app/_layout.tsx` wires the real
 * `AppState`; tests use an in-memory fake.
 */
export type AppLifecycleState = "active" | "background" | "inactive" | "extension" | "unknown";

/**
 * The only thing outbox recovery needs from the host app's lifecycle.
 */
export interface AppLifecycleSource {
  subscribe(onChange: (nextState: AppLifecycleState) => void): () => void;
}

/**
 * The only thing outbox recovery needs from the device's connectivity:
 * "is there a network connection right now". `app/_layout.tsx` wires the
 * real `expo-network` listener (see
 * src/infrastructure/expo-network-connectivity.ts); tests use a fake.
 */
export interface ConnectivitySource {
  subscribe(onChange: (isConnected: boolean) => void): () => void;
}

export interface SyncRequestTarget {
  requestSync(trigger: WorkoutSyncTrigger): void;
}

/**
 * Application-level sync triggers for the workout outbox (called once from
 * `app/_layout.tsx`, never from a screen):
 *
 * - launch: once, immediately — reconciles commands a previous process
 *   left PENDING/RETRY/SYNCING;
 * - foreground resume: every transition to "active";
 * - network regain: every connectivity transition unavailable -> available.
 *
 * Every trigger goes to the one `WorkoutSyncCoordinator`, which owns
 * single-flight, coalescing and the retry backoff. Network regain alone
 * cannot cover a backend outage while the device stays connected (Manual
 * Test #4) — the coordinator's retry timer does.
 */
export function startOutboxSyncRecovery(
  target: SyncRequestTarget,
  lifecycleSource: AppLifecycleSource,
  connectivitySource?: ConnectivitySource,
): () => void {
  target.requestSync("launch");

  const unsubscribeLifecycle = lifecycleSource.subscribe((nextState) => {
    if (nextState === "active") target.requestSync("foreground");
  });

  // `undefined` until the first report: the first report is a baseline,
  // not a transition (launch already requested a sync).
  let lastConnected: boolean | undefined;
  const unsubscribeConnectivity = connectivitySource?.subscribe((isConnected) => {
    const regained = lastConnected === false && isConnected;
    lastConnected = isConnected;
    if (regained) target.requestSync("network-regain");
  });

  return () => {
    unsubscribeLifecycle();
    unsubscribeConnectivity?.();
  };
}
