import { AppState, type AppStateStatus } from "react-native";
import type { AppLifecycleSource } from "./sync-recovery";

/**
 * The one place `AppState` is wired to real React Native — everything
 * else in src/infrastructure/sync-recovery.ts is framework-agnostic and
 * unit-tested with a fake of this same interface.
 */
export const reactNativeAppLifecycleSource: AppLifecycleSource = {
  subscribe(onChange) {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => onChange(nextState));
    return () => subscription.remove();
  },
};
