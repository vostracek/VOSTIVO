import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { installDomainIdGenerator } from "../src/infrastructure/domain-id-generator";
import { IdentityGate } from "../src/identity/identity-gate";

// Runs once, at module load — before any screen mounts and therefore
// before any code could call createEntityId(). See
// src/infrastructure/domain-id-generator.ts for why this is an explicit
// call rather than a global crypto.getRandomValues polyfill.
installDomainIdGenerator();

/**
 * Auth & Local Athlete Boundary V1 Slice B: the screen tree exists ONLY
 * under the IdentityGate's READY state — the gate resolves the verified
 * athlete, opens that athlete's own encrypted database, builds their
 * runtime and starts their outbox sync triggers (launch, foreground,
 * network regain) before any screen mounts, and remounts the whole Stack
 * (keyed by `userId`) on an owner change.
 */
export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <IdentityGate>
        <Stack screenOptions={{ headerShown: false }} />
      </IdentityGate>
    </>
  );
}
