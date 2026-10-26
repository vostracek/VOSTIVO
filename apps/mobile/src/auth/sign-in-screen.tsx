import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { authErrorCopy } from "./auth-errors";
import { OTP_LENGTH, SignInFlowController, type SignInState } from "./sign-in-flow";
import type { EmailOtpSignIn } from "./supabase-auth-session-source";

export type SignInPurpose = "SIGN_IN" | "REAUTH";

const systemClock = (): number => Date.now();

interface SignInScreenProps {
  readonly signIn: EmailOtpSignIn;
  readonly purpose: SignInPurpose;
  /** Re-auth only: return to the (still usable) app without signing in now. */
  readonly onNotNow?: () => void;
}

/**
 * Auth Slice C — email + 6-digit code. Renders `SignInFlowController`; all
 * copy for failures comes from `authErrorCopy` (never a raw SDK message).
 */
export function SignInScreen({ signIn, purpose, onNotNow }: SignInScreenProps): React.JSX.Element {
  const [state, setState] = useState<SignInState>({ step: "EMAIL", email: "", sending: false, error: null });
  const controller = useMemo(() => new SignInFlowController({ signIn, now: systemClock }, setState), [signIn]);
  const [, setTick] = useState(0);

  // Re-render once a second while a resend cooldown is running.
  const coolingDown = state.step === "CODE" && controller.resendSecondsRemaining() > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [coolingDown]);

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.content}>
          {state.step === "CODE" ? <CodeStep state={state} controller={controller} /> : <EmailStep state={state} controller={controller} purpose={purpose} />}
          {onNotNow === undefined || state.step === "SIGNED_IN" ? null : (
            <Pressable onPress={onNotNow} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.textButtonLabel}>Not now</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function EmailStep({ state, controller, purpose }: { state: SignInState; controller: SignInFlowController; purpose: SignInPurpose }): React.JSX.Element {
  if (state.step === "SIGNED_IN") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    );
  }
  const email = state.step === "EMAIL" ? state.email : "";
  const sending = state.step === "EMAIL" && state.sending;
  const error = state.step === "EMAIL" ? state.error : null;
  return (
    <>
      <Text style={styles.title}>{purpose === "REAUTH" ? "Sign in again to sync" : "Sign in to Vostivo"}</Text>
      <Text style={styles.body}>
        {purpose === "REAUTH"
          ? "Your training on this phone is safe. Use the same email to keep it syncing."
          : "Enter your email and we'll send you a 6-digit code."}
      </Text>
      <TextInput
        value={email}
        onChangeText={(text) => controller.setEmail(text)}
        onSubmitEditing={() => void controller.submitEmail()}
        editable={!sending}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="send"
        placeholder="you@example.com"
        placeholderTextColor={colors.textTertiary}
        style={styles.input}
        accessibilityLabel="Email"
      />
      {error === null ? null : <Text style={styles.error}>{authErrorCopy(error)}</Text>}
      <PrimaryButton label={sending ? "Sending code…" : "Send code"} disabled={sending || email.trim().length === 0} onPress={() => void controller.submitEmail()} />
    </>
  );
}

function CodeStep({ state, controller }: { state: Extract<SignInState, { step: "CODE" }>; controller: SignInFlowController }): React.JSX.Element {
  const secondsLeft = controller.resendSecondsRemaining();
  const busy = state.busy !== "IDLE";
  return (
    <>
      <Text style={styles.title}>Enter your code</Text>
      <Text style={styles.body}>
        {state.resent ? "We sent a new code to " : "We sent a 6-digit code to "}
        <Text style={styles.bodyStrong}>{state.email}</Text>
      </Text>
      <TextInput
        value={state.code}
        onChangeText={(text) => controller.setCode(text)}
        onSubmitEditing={() => void controller.submitCode()}
        editable={!busy}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={OTP_LENGTH}
        placeholder="••••••"
        placeholderTextColor={colors.textTertiary}
        style={[styles.input, styles.codeInput]}
        accessibilityLabel="6-digit code"
        autoFocus
      />
      {state.error === null ? null : <Text style={styles.error}>{authErrorCopy(state.error)}</Text>}
      <PrimaryButton label={state.busy === "VERIFYING" ? "Verifying…" : "Verify"} disabled={!controller.canVerify()} onPress={() => void controller.submitCode()} />
      <View style={styles.row}>
        <Pressable onPress={() => void controller.resend()} disabled={busy || secondsLeft > 0} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={[styles.textButtonLabel, (busy || secondsLeft > 0) && styles.textButtonDisabled]}>
            {state.busy === "RESENDING" ? "Sending…" : secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : "Resend code"}
          </Text>
        </Pressable>
        <Pressable onPress={() => controller.changeEmail()} disabled={busy} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={[styles.textButtonLabel, busy && styles.textButtonDisabled]}>Change email</Text>
        </Pressable>
      </View>
    </>
  );
}

function PrimaryButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, disabled && styles.primaryButtonDisabled]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: spacing.screenGutter, gap: spacing.md },
  center: { alignItems: "center" },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.sm },
  bodyStrong: { ...typography.bodyStrong, color: colors.textPrimary },
  input: {
    minHeight: touchTarget.minHeight,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    color: colors.textPrimary,
    ...typography.body,
  },
  codeInput: { fontSize: 24, fontWeight: "600", letterSpacing: 8, textAlign: "center" },
  error: { ...typography.caption, color: colors.danger },
  primaryButton: {
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  row: { flexDirection: "row", justifyContent: "space-between" },
  textButton: { minHeight: touchTarget.minHeight, justifyContent: "center", alignSelf: "center", paddingHorizontal: spacing.sm },
  textButtonLabel: { ...typography.bodyStrong, color: colors.textSecondary },
  textButtonDisabled: { color: colors.textTertiary },
  pressed: { opacity: 0.7 },
});
