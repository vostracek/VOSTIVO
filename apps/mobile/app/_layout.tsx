import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { installDomainIdGenerator } from "../src/infrastructure/domain-id-generator";
import { startOutboxSyncRecovery, type AppLifecycleSource } from "../src/infrastructure/sync-recovery";
import { createExpoNetworkConnectivitySource } from "../src/infrastructure/expo-network-connectivity";
import { getWorkoutSyncCoordinator } from "../src/plan/plan-runtime";

// Runs once, at module load — before any screen mounts and therefore
// before any code could call createEntityId(). See
// src/infrastructure/domain-id-generator.ts for why this is an explicit
// call rather than a global crypto.getRandomValues polyfill.
installDomainIdGenerator();

// The one place `AppState` is wired to real React Native — everything
// else in src/infrastructure/sync-recovery.ts is framework-agnostic and
// unit-tested with a fake of this same interface.
const reactNativeAppLifecycleSource: AppLifecycleSource = {
  subscribe(onChange) {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => onChange(nextState));
    return () => subscription.remove();
  },
};

export default function RootLayout() {
  // Outbox sync triggers are application-owned (not scattered across
  // screens): launch, foreground and network regain all feed the one
  // WorkoutSyncCoordinator, which also owns the retry backoff. Mounts once
  // for the app's lifetime; cleans up its AppState and connectivity
  // subscriptions on unmount (and on Fast Refresh, before re-subscribing).
  useEffect(() => {
    return startOutboxSyncRecovery(
      getWorkoutSyncCoordinator(),
      reactNativeAppLifecycleSource,
      createExpoNetworkConnectivitySource(),
    );
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
