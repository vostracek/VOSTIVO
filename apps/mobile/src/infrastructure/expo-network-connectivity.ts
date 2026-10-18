import { requireOptionalNativeModule } from "expo";
import type { ConnectivitySource } from "./sync-recovery";

type ExpoNetworkModule = typeof import("expo-network");

/**
 * The one place `expo-network` is wired to the outbox triggers.
 *
 * `isConnected` (not `isInternetReachable`) is the signal: the API is
 * often reachable without public internet (a LAN or emulator host, e.g.
 * `10.0.2.2`), and an "unreachable internet" report must not suppress a
 * sync attempt that the retry backoff would make anyway.
 *
 * `expo-network` is a native module. A development build compiled before
 * it was added has no `ExpoNetwork` native module, and importing the
 * package there throws at module load. The module is therefore loaded only
 * after the native side is confirmed present; without it, this returns
 * `undefined` and the network-regain trigger is simply absent — the
 * coordinator's retry backoff still recovers every pending command.
 */
export function createExpoNetworkConnectivitySource(): ConnectivitySource | undefined {
  if (requireOptionalNativeModule("ExpoNetwork") === null) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only after the native-module check above (see doc comment)
  const network = require("expo-network") as ExpoNetworkModule;

  return {
    subscribe(onChange) {
      const subscription = network.addNetworkStateListener((state) => onChange(state.isConnected === true));
      void network
        .getNetworkStateAsync()
        .then((state) => onChange(state.isConnected === true))
        .catch(() => {
          // No initial reading: the first listener event becomes the baseline.
        });
      return () => subscription.remove();
    },
  };
}
