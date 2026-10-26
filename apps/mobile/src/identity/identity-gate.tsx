import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePathname } from "expo-router";
import type { AthleteRuntime } from "../plan/plan-runtime";
import { getPlanApiBaseUrl, resolveVostivoEnvironment } from "../infrastructure/plan-runtime-config";
import { expoSecureValueStore } from "../infrastructure/secure-value-store";
import { reactNativeAppLifecycleSource } from "../infrastructure/react-native-app-lifecycle";
import { createExpoNetworkConnectivitySource } from "../infrastructure/expo-network-connectivity";
import { startOutboxSyncRecovery } from "../infrastructure/sync-recovery";
import type { WorkoutSyncLogger } from "../infrastructure/workout-sync-coordinator";
import { openNativeAthleteDatabase } from "../local-database/client";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { createSupabaseAuthSessionSource } from "../auth/supabase-auth-client";
import { SignInScreen } from "../auth/sign-in-screen";
import type { EmailOtpSignIn } from "../auth/supabase-auth-session-source";
import { createAuthSessionWiring, type AuthSessionWiring } from "./auth-session-config";
import type { DevAuthSessionSource } from "./dev-auth-session-source";
import { IdentityBindingStore } from "./identity-binding-store";
import { IdentityGateController, type IdentityGateState } from "./identity-gate-controller";
import { identityGateCopy } from "./identity-gate-presentation";
import { resolveIdentity, unauthorizedRetryFor } from "./identity-resolution";
import { createAthleteRuntimeOpener } from "./athlete-runtime-opener";
import { fetchVerifiedMe } from "./verified-me-client";
import { AthleteRuntimeProvider } from "./athlete-runtime-context";
import { nextAuthRecoveryCount, type ReadyAuthStatus } from "./auth-recovery";

// DEV-only: counts, triggers and delays — never tokens or workout payloads.
const devSyncLogger: WorkoutSyncLogger = {
  debug: (message, details) => console.debug(`[workout-sync] ${message}`, details ?? {}),
};

/** The Active Workout route: re-auth never interrupts it with a full-screen sign-in (Slice C §8). */
const ACTIVE_WORKOUT_PATH = "/active-workout";

/** Build-time session wiring (literal `process.env.EXPO_PUBLIC_*` reads so Expo inlines them). */
function createAppAuthSessionWiring(): AuthSessionWiring {
  return createAuthSessionWiring(
    {
      environment: resolveVostivoEnvironment(),
      devJwt: process.env.EXPO_PUBLIC_DEV_JWT,
      devJwts: process.env.EXPO_PUBLIC_DEV_JWTS,
      isDevBuild: __DEV__,
      supabase: { url: process.env.EXPO_PUBLIC_SUPABASE_URL, publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
    },
    expoSecureValueStore,
    (config) => createSupabaseAuthSessionSource(config, expoSecureValueStore),
  );
}

/**
 * Auth & Local Athlete Boundary V1 — the root IdentityGate. Nothing
 * athlete-owned exists below it until READY: no screen, no runtime, no
 * opened athlete database, no sync. READY renders the screen tree keyed by
 * the verified `userId`, so an owner change always mounts a fresh tree.
 * Slice C: signed out -> email OTP sign-in; an invalid session while READY
 * keeps the owner's tree (an active workout stays usable) and asks to sign
 * in again to resume sync.
 */
export function IdentityGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [wiring] = useState(createAppAuthSessionWiring);
  const [state, setState] = useState<IdentityGateState<AthleteRuntime>>({ status: "BOOTING" });
  const controllerRef = useRef<IdentityGateController<AthleteRuntime> | null>(null);
  const authRecoveries = useAuthRecoveryCounter(state.status === "READY" ? state.auth : null);

  useEffect(() => {
    if (wiring.configurationError !== null) return;
    let cancelled = false;
    let controller: IdentityGateController<AthleteRuntime> | null = null;
    const bindings = new IdentityBindingStore(expoSecureValueStore);
    const detachAuthLifecycle = wiring.supabase?.attachAppLifecycle(reactNativeAppLifecycleSource);

    void (async () => {
      const apiBaseUrl = getPlanApiBaseUrl();
      await wiring.devIdentitySwitcher?.restoreSelection();
      if (cancelled) return;
      controller = new IdentityGateController<AthleteRuntime>({
        sessionSource: wiring.source,
        resolveIdentity: (session) =>
          resolveIdentity(session, {
            fetchMe: (accessToken) => fetchVerifiedMe(apiBaseUrl, accessToken),
            bindings,
            now: () => new Date(),
            ...unauthorizedRetryFor(wiring.source),
          }),
        openRuntime: createAthleteRuntimeOpener({
          sessionSource: wiring.source,
          apiBaseUrl,
          openDatabase: openNativeAthleteDatabase,
          syncLogger: __DEV__ ? devSyncLogger : undefined,
          onSessionInvalid: () => void controllerRef.current?.reevaluate(),
        }),
        onStateChange: setState,
        connectivity: createExpoNetworkConnectivitySource(),
        appLifecycle: reactNativeAppLifecycleSource,
      });
      controllerRef.current = controller;
      controller.start();
    })().catch(() => {
      if (!cancelled) setState({ status: "IDENTITY_ERROR", reason: "UNEXPECTED" });
    });

    return () => {
      cancelled = true;
      controllerRef.current = null;
      detachAuthLifecycle?.();
      void controller?.stop();
    };
  }, [wiring]);

  const switcher = wiring.devIdentitySwitcher;
  const devPill = switcher === null ? null : <DevIdentitySwitcher switcher={switcher} />;

  if (wiring.configurationError !== null) {
    return (
      <GateMessage title="Sign-in isn't available" body={__DEV__ ? wiring.configurationError : "This build isn't set up for sign-in. Please update the app."}>
        {devPill}
      </GateMessage>
    );
  }

  if (state.status === "READY") {
    return (
      <AthleteRuntimeProvider key={state.identity.userId} runtime={state.runtime} authRecoveries={authRecoveries}>
        <AthleteSyncRecovery runtime={state.runtime} />
        {children}
        {state.auth === "REAUTH_REQUIRED" ? <ReauthPrompt signIn={wiring.supabase} /> : null}
        {devPill}
      </AthleteRuntimeProvider>
    );
  }

  if ((state.status === "SIGNED_OUT" || state.status === "REAUTH_REQUIRED") && wiring.supabase !== null) {
    return (
      <View style={styles.screen}>
        <SignInScreen signIn={wiring.supabase} purpose={state.status === "REAUTH_REQUIRED" ? "REAUTH" : "SIGN_IN"} />
        {devPill}
      </View>
    );
  }

  const copy = identityGateCopy(state, __DEV__);
  return (
    <GateMessage title={copy.title} body={copy.body} busy={copy.retryLabel === null && (state.status === "BOOTING" || state.status === "VERIFYING")}>
      {copy.retryLabel === null ? null : (
        <Pressable onPress={() => void controllerRef.current?.reevaluate()} style={({ pressed }) => [styles.button, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={styles.buttonText}>{copy.retryLabel}</Text>
        </Pressable>
      )}
      {devPill}
    </GateMessage>
  );
}

function GateMessage({ title, body, busy = false, children }: { title: string; body: string; busy?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.center}>
        {busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
        <Text style={styles.title}>{title}</Text>
        {body.length === 0 ? null : <Text style={styles.body}>{body}</Text>}
      </View>
      {children}
    </SafeAreaView>
  );
}

/** Counts `REAUTH_REQUIRED -> VALID` transitions of the READY owner (see `nextAuthRecoveryCount`). */
function useAuthRecoveryCounter(auth: ReadyAuthStatus | null): number {
  const [tracked, setTracked] = useState<{ auth: ReadyAuthStatus | null; count: number }>({ auth, count: 0 });
  if (tracked.auth !== auth) {
    setTracked({ auth, count: nextAuthRecoveryCount(tracked.auth, auth, tracked.count) });
  }
  return tracked.auth === auth ? tracked.count : nextAuthRecoveryCount(tracked.auth, auth, tracked.count);
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
 * Auth Slice C — the open owner's session is no longer valid. Their data
 * and any active workout stay fully usable; only sync is paused. Outside
 * Active Workout the sign-in sheet opens once ("Not now" leaves a quiet
 * pill); during Active Workout only the pill is shown — never a sign-in
 * screen mid-set.
 */
function ReauthPrompt({ signIn }: { signIn: EmailOtpSignIn | null }): React.JSX.Element {
  const pathname = usePathname();
  const inActiveWorkout = pathname === ACTIVE_WORKOUT_PATH;
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const sheetVisible = signIn !== null && (open || (!dismissed && !inActiveWorkout));

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={signIn === null}
        style={({ pressed }) => [styles.reauthPill, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Sign in again to sync"
      >
        <Text style={styles.reauthPillText}>Sign in again to sync</Text>
      </Pressable>
      {signIn === null ? null : (
        <Modal
          visible={sheetVisible}
          animationType="slide"
          onRequestClose={() => {
            setOpen(false);
            setDismissed(true);
          }}
        >
          <SignInScreen
            signIn={signIn}
            purpose="REAUTH"
            onNotNow={() => {
              setOpen(false);
              setDismissed(true);
            }}
          />
        </Modal>
      )}
    </>
  );
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
    alignSelf: "center",
    marginBottom: spacing.xxl,
  },
  buttonText: { ...typography.bodyStrong, color: colors.textPrimary },
  pressed: { opacity: 0.7 },
  reauthPill: {
    position: "absolute",
    top: 44,
    left: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.signal,
    backgroundColor: colors.surfaceElevated,
  },
  reauthPillText: { ...typography.tiny, color: colors.signal },
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
