import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import type { MeResponse, PlanOverviewV1 } from "@vostivo/contracts";
import appConfig from "../../app.json";
import { useAthleteRuntime } from "../../src/identity/athlete-runtime-context";
import { useAccount } from "../../src/account/account-context";
import { checkBeforeSignOut, SIGN_OUT_COPY, type UnsyncedWork } from "../../src/account/sign-out-flow";
import { accountLine, profileIdentity, trainingRows, type ProfileInfoRow } from "../../src/profile/profile-presentation";
import { resolveVostivoEnvironment } from "../../src/infrastructure/plan-runtime-config";
import { logTechnicalFailure } from "../../src/plan/plan-runtime";
import { BottomNav } from "../../src/ui/bottom-nav";
import { Icon, type IconName } from "../../src/ui/icon";
import { Hairline, LoadingBlocks, SecondaryButton, SectionHeader, StateMessage, TopGlow } from "../../src/ui/primitives";
import { semantic, spacing, type } from "../../src/design/tokens";

/**
 * Profile V1 + minimal Account (Athlete Design Integration 01; Auth &
 * Local Athlete Boundary V1 Slice D, decision D-7: the Profile tab is the
 * Account surface).
 *
 * Visual structure: the approved Claude Design `Vostivo Profile` canvas —
 * page title, identity block, titled sections of icon rows with hairlines.
 * Content: ONLY what V1 really has — `GET /me` (mode, units, training time
 * zone), the current plan block, the signed-in identity, sign-out and the
 * app version. Every row is read-only information (no chevron, nothing to
 * tap); the one action is Sign out. Everything else on the canvas needs a
 * backend contract that does not exist yet and is deferred, not faked.
 */

type LoadState = { readonly kind: "LOADING" } | { readonly kind: "ERROR" } | { readonly kind: "READY"; readonly me: MeResponse; readonly plan: PlanOverviewV1 | null };

type SignOutState =
  | { readonly kind: "IDLE" }
  | { readonly kind: "CHECKING" }
  | { readonly kind: "CONFIRM"; readonly work: UnsyncedWork }
  | { readonly kind: "SIGNING_OUT" }
  | { readonly kind: "FAILED" };

export default function ProfileScreen(): React.JSX.Element {
  const { profileReads, planApplicationService, signOutCheckPorts } = useAthleteRuntime();
  const account = useAccount();
  const [state, setState] = useState<LoadState>({ kind: "LOADING" });
  const [email, setEmail] = useState<string | null>(null);
  const [signOut, setSignOut] = useState<SignOutState>({ kind: "IDLE" });
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  useFocusEffect(reload);

  useEffect(() => {
    let cancelled = false;
    Promise.all([profileReads.getMe(), planApplicationService.getCurrentPlan().catch(() => null)])
      .then(([me, plan]) => {
        if (!cancelled) setState({ kind: "READY", me, plan });
      })
      .catch((error: unknown) => {
        logTechnicalFailure(`profile read failed (${error instanceof Error ? error.name : typeof error})`);
        if (!cancelled) setState((current) => (current.kind === "READY" ? current : { kind: "ERROR" }));
      });
    void account.readEmail().then((value) => {
      if (!cancelled) setEmail(value);
    });
    return () => {
      cancelled = true;
    };
  }, [profileReads, planApplicationService, account, reloadToken]);

  const performSignOut = useCallback(async () => {
    setSignOut({ kind: "SIGNING_OUT" });
    // On success the IdentityGate unmounts this whole tree (owner disposed first).
    const result = await account.signOut();
    if (result === "FAILED") setSignOut({ kind: "FAILED" });
  }, [account]);

  const onSignOut = useCallback(async () => {
    setSignOut({ kind: "CHECKING" });
    try {
      const check = await checkBeforeSignOut(signOutCheckPorts);
      if (check.kind === "UNSYNCED") {
        setSignOut({ kind: "CONFIRM", work: check.work });
        return;
      }
    } catch {
      // The local check itself failed: never sign out silently — ask.
      setSignOut({ kind: "CONFIRM", work: { pendingCommands: 1, hasActiveWorkout: false } });
      return;
    }
    await performSignOut();
  }, [signOutCheckPorts, performSignOut]);

  const environment = resolveVostivoEnvironment();
  const busy = signOut.kind === "CHECKING" || signOut.kind === "SIGNING_OUT";
  const accountView = accountLine(account.signInMethod, email);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TopGlow />
        <Text style={styles.screenTitle} accessibilityRole="header">
          Profile
        </Text>

        {state.kind === "LOADING" ? <LoadingBlocks label="Loading your profile" rows={4} /> : null}
        {state.kind === "ERROR" ? (
          <StateMessage title="Couldn't load your profile" body="Check your connection and try again. Your account options below still work.">
            <SecondaryButton label="Try again" onPress={reload} style={styles.inlineButton} />
          </StateMessage>
        ) : null}
        {state.kind === "READY" ? <ReadyProfile me={state.me} plan={state.plan} /> : null}

        <View style={styles.section}>
          <SectionHeader label="Data & account" />
          <View>
            <InfoRow icon="account" title={accountView.title} description={accountView.description} />
          </View>
          {account.signOutAvailable ? (
            <View style={styles.signOutBlock}>
              {signOut.kind === "FAILED" ? <Text style={styles.errorText}>{SIGN_OUT_COPY.failed}</Text> : null}
              <SecondaryButton
                label={signOut.kind === "CHECKING" ? SIGN_OUT_COPY.checking : signOut.kind === "SIGNING_OUT" ? SIGN_OUT_COPY.signingOut : SIGN_OUT_COPY.action}
                loading={busy}
                onPress={() => void onSignOut()}
                accessibilityLabel="Sign out"
              />
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <SectionHeader label="App & about" />
          <View>
            <InfoRow icon="about" title="Version" value={appConfig.expo.version} />
            {environment !== "production" ? (
              <>
                <Hairline />
                <InfoRow icon="privacy" title="Build" value={`${environment} · not production`} />
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>
      <BottomNav active="profile" />
      {signOut.kind === "CONFIRM" ? (
        <UnsyncedSignOutSheet
          work={signOut.work}
          onStay={() => setSignOut({ kind: "IDLE" })}
          onSignOut={() => void performSignOut()}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ReadyProfile({ me, plan }: { me: MeResponse; plan: PlanOverviewV1 | null }): React.JSX.Element {
  const identity = profileIdentity(me, plan);
  const rows = trainingRows(me, plan);
  return (
    <>
      <View style={styles.identity} accessible accessibilityLabel={[identity.title, identity.meta].filter((part) => part !== null).join(". ")}>
        <Text style={styles.identityTitle}>{identity.title}</Text>
        {identity.meta !== null ? <Text style={styles.identityMeta}>{identity.meta}</Text> : null}
      </View>
      <View style={styles.section}>
        <SectionHeader label="Training" />
        <View>
          {rows.map((row, index) => (
            <View key={row.key}>
              {index > 0 ? <Hairline /> : null}
              <InfoRow icon={ROW_ICON[row.key]} title={row.title} description={row.description} value={row.value} />
            </View>
          ))}
        </View>
      </View>
    </>
  );
}

const ROW_ICON: Record<ProfileInfoRow["key"], IconName> = { block: "plan", mode: "trainingProfile", units: "trainingProfile", tz: "clock" };

/** Foundations §11 settings-row grammar, read-only: icon, title, description or trailing value — no chevron, no press. */
function InfoRow({ icon, title, description, value }: { icon: IconName; title: string; description?: string; value?: string }): React.JSX.Element {
  return (
    <View style={styles.row} accessible accessibilityLabel={[title, description, value].filter((part) => part !== undefined).join(", ")}>
      <Icon name={icon} size={19} strokeWidth={1.6} color="#8A9196" />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {description !== undefined ? <Text style={styles.rowDescription}>{description}</Text> : null}
      </View>
      {value !== undefined ? (
        <Text style={styles.rowValue} numberOfLines={2}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/** AUTH-LOCAL-BOUNDARY §10 confirmation — Foundations-derived sheet (no approved design exists). */
function UnsyncedSignOutSheet({ work, onStay, onSignOut }: { work: UnsyncedWork; onStay: () => void; onSignOut: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <LinearGradient colors={["#16191C", "#111416"]} style={[styles.sheet, { paddingBottom: spacing.s40 + insets.bottom }]}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle} accessibilityRole="header">
          {SIGN_OUT_COPY.unsyncedTitle}
        </Text>
        <Text style={styles.sheetBody}>{work.hasActiveWorkout && work.pendingCommands === 0 ? SIGN_OUT_COPY.activeWorkoutBody : SIGN_OUT_COPY.unsyncedBody}</Text>
        <View style={styles.sheetActions}>
          <SecondaryButton label={SIGN_OUT_COPY.stay} onPress={onStay} style={styles.flex} />
          <SecondaryButton label={SIGN_OUT_COPY.confirm} onPress={onSignOut} style={styles.flex} />
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: semantic.bgApp },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.screenGutter, paddingBottom: spacing.bottomClearance, gap: spacing.sectionRhythm + 4 },
  screenTitle: { ...type.pageTitle, color: semantic.textPrimary, paddingTop: spacing.xl },
  identity: { gap: spacing.sm },
  identityTitle: { ...type.blockTitle, fontSize: 26, lineHeight: 30, color: semantic.textPrimary },
  identityMeta: { ...type.body, color: semantic.textMuted },
  section: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 56, paddingVertical: spacing.md },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { ...type.rowTitle, color: semantic.textPrimary },
  rowDescription: { ...type.body, fontSize: 12, lineHeight: 17, color: semantic.textMuted },
  rowValue: { ...type.labelValue, maxWidth: "52%", textAlign: "right", color: semantic.textTertiary },
  signOutBlock: { paddingTop: spacing.sm, gap: spacing.sm },
  inlineButton: { alignSelf: "flex-start" },
  errorText: { ...type.body, color: semantic.critical },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: semantic.scrim, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: spacing.screenGutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.s40,
    gap: spacing.md,
  },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.14)", marginBottom: spacing.sm },
  sheetTitle: { ...type.sessionTitle, color: semantic.textPrimary },
  sheetBody: { ...type.body, color: semantic.textMuted },
  sheetActions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
});
