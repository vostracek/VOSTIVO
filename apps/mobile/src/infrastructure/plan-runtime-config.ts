import { ENVIRONMENTS, type Environment } from "@vostivo/config";

/**
 * Fails closed: an unset or unrecognized value resolves to `"production"`,
 * the strictest environment, never a permissive default.
 */
export function resolveVostivoEnvironment(): Environment {
  const raw = process.env.EXPO_PUBLIC_VOSTIVO_ENV;
  if (raw !== undefined && (ENVIRONMENTS as readonly string[]).includes(raw)) {
    return raw as Environment;
  }
  return "production";
}

export function getPlanApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  // No production API deployment exists yet either — failing loudly here
  // is the honest behavior, not a silent fallback to some guessed URL.
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL is not configured — no production API endpoint exists yet. " +
      "See docs/architecture/PLAN-PRESCRIPTION.md.",
  );
}
