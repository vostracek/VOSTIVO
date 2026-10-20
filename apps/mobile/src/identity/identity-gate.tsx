import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AthleteRuntime } from "../plan/plan-runtime";
import { getPlanApiBaseUrl, resolveVostivoEnvironment } from "../infrastructure/plan-runtime-config";
import { expoSecureValueStore } from "../infrastructure/secure-value-store";
import { reactNativeAppLifecycleSource } from "../infrastructure/react-native-app-lifecycle";
import { createExpoNetworkConnectivitySource } from "../infrastructure/expo-network-connectivity";
import { startOutboxSyncRecovery } from "../infrastructure/sync-recovery";
import type { WorkoutSyncLogger } from "../infrastructure/workout-sync-coordinator";
import { openNativeAthleteDatabase } from "../local-database/client";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { createAuthSessionWiring, type AuthSessionWiring } from "./auth-session-config";
import type { DevAuthSessionSource } from "./dev-auth-session-source";
import { IdentityBindingStore } from "./identity-binding-store";
import { IdentityGateController, type IdentityGateState } from "./identity-gate-controller";
import { identityGateCopy } from "./identity-gate-presentation";
import { resolveIdentity } from "./identity-resolution";
import { createAthleteRuntimeOpener } from "./athlete-runtime-opener";
import { fetchVerifiedMe } from "./verified-me-client";
import { AthleteRuntimeProvider } from "./athlete-runtime-context";

// DEV-only: counts, triggers and delays — never tokens or workout payloads.
const devSyncLogger: WorkoutSyncLogger = {
  debug: (message, details) => console.debug(`[workout-sync] ${message}`, details ?? {}),
};

/** Build-time session wiring (literal `process.env.EXPO_PUBLIC_*` reads so Expo inlines them). */
function createAppAuthSessionWiring(): AuthSessionWiring {
  return createAuthSessionWiring(
    {
      environment: resolveVostivoEnvironment(),
      devJwt: process.env.EXPO_PUBLIC_DEV_JWT,
      devJwts: process.env.EXPO_PUBLIC_DEV_JWTS,
      isDevBuild: __DEV__,
    },
    expoSecureValueStore,
  );
}

/**
 * Auth & Local Athlete Boundary V1 Slice B — the root IdentityGate. Nothing
 * athlete-owned exists below it until READY: no screen, no runtime, no
 * opened athlete database, no sync. READY renders the screen tree keyed by
 * the verified `userId`, so an owner change always mounts a fresh tree.
 */
export function IdentityGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [wiring] = useState(createAppAuthSessionWiring);
  const [state, setState] = useState<IdentityGateState<AthleteRuntime>>({ status: "BOOTING" });
  const controllerRef = useRef<IdentityGateController<AthleteRuntime> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: IdentityGateController<AthleteRuntime> | null = null;
    const bindings = new IdentityBindingStore(expoSecureValueStore);

    void (async () => {
      const apiBaseUrl = getPlanApiBaseUrl();
      await wiring.devIdentitySwitcher?.restoreSelection();
      if (cancelled) return;
      controller = new IdentityGateController<AthleteRuntime>({
        sessionSource: wiring.source,
        resolveIdentity: (session) => resolveIdentity(session, { fetchMe: (accessToken) => fetchVerifiedMe(apiBaseUrl, accessToken), bindings, now: () => new Date() }),
        openRuntime: createAthleteRuntimeOpener({
          sessionSource: wiring.source,
          apiBaseUrl,
          openDatabase: openNativeAthleteDatabase,
          syncLogger: __DEV__ ? devSyncLogger : undefined,
        }),
        onStateChange: setState,
      });
      controllerRef.current = controller;
      controller.start();
    })().catch(() => {
      if (!cancelled) setState({ status: "IDENTITY_ERROR", reason: "UNEXPECTED" });
    });

    return () => {
      cancelled = true;
      controllerRef.current = null;
      void controller?.stop();
    };
  }, [wiring]);

  const switcher = wiring.devIdentitySwitcher;

  if (state.status === "READY") {
    return (
      <AthleteRuntimeProvider key={state.identity.userId} runtime={state.runtime}>
        <AthleteSyncRecovery runtime={state.runtime} />
        {children}
        {switcher === null ? null : <DevIdentitySwitcher switcher={switcher} />}
      </AthleteRuntimeProvider>
    );
  }

  const copy = identityGateCopy(state, __DEV__);
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.center}>
        {copy.retryLabel === null && (state.status === "BOOTING" || state.status === "VERIFYING") ? <ActivityIndicator color={colors.textSecondary} /> : null}
        <Text style={styles.title}>{copy.title}</Text>
        {copy.body.length === 0 ? null : <Text style={styles.body}>{copy.body}</Text>}
        {copy.retryLabel === null ? null : (
          <Pressable
            onPress={() => void controllerRef.current?.reevaluate()}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{copy.retryLabel}</Text>
          </Pressable>
        )}
      </View>
      {switcher === null ? null : <DevIdentitySwitcher switcher={switcher} />}
    </SafeAreaView>
  );
}

/**
 * Outbox sync triggers (launch, foreground, network regain) for THIS
 * owner's coordinator only. Mounted inside the owner-keyed tree, so an
 * owner change unsubscribes them before anything of the next owner exists.
 */
function AthleteSyncRecovery({ runtime }: { runtime: AthleteRuntime }): null {
  useEffect(() => startOutboxSyncRecovery(runtime.workoutSyncCoordinator, reactNativeAppLifecycleSource, createExpoNetworkConnectivitySource()), [runtime]);
  return null;
}

/**
 * D-8 dev-only identity selector. Only ever constructed when `__DEV__` is
 * true (see `createAuthSessionWiring`); shows safe aliases, never tokens.
 * Selecting an alias only changes the session — the IdentityGate then runs
 * its normal transition; there is no database shortcut.
 */
function DevIdentitySwitcher({ switcher }: { switcher: DevAuthSessionSource }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [currentAlias, setCurrentAlias] = useState(switcher.currentAlias);
  useEffect(() => switcher.subscribe(() => setCurrentAlias(switcher.currentAlias)), [switcher]);

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.devPill} accessibilityRole="button" accessibilityLabel={`Dev identity ${currentAlias}. Switch identity`}>
        <Text style={styles.devPillText}>DEV · {currentAlias}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Dev identity</Text>
            {switcher.aliases.map((alias) => (
              <Pressable
                key={alias}
                onPress={() => {
                  setOpen(false);
                  void switcher.select(alias);
                }}
                style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityState={{ selected: alias === currentAlias }}
              >
                <Text style={[styles.sheetRowText, alias === currentAlias && styles.sheetRowTextSelected]}>{alias}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.screenGutter, gap: spacing.md },
  title: { ...typography.heading, color: colors.textPrimary, textAlign: "center" },
  body: { ...typography.body, color: colors.textSecondary, textAlign: "center" },
  button: {
    marginTop: spacing.sm,
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { ...typography.bodyStrong, color: colors.textPrimary },
  pressed: { opacity: 0.7 },
  devPill: {
    position: "absolute",
    top: 44,
    right: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  devPillText: { ...typography.tiny, color: colors.textSecondary },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing.xl },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.xs },
  sheetTitle: { ...typography.bodyStrong, color: colors.textPrimary, marginBottom: spacing.sm },
  sheetRow: { minHeight: touchTarget.minHeight, justifyContent: "center", paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  sheetRowText: { ...typography.body, color: colors.textSecondary },
  sheetRowTextSelected: { color: colors.textPrimary, fontWeight: "600" },
});
