/**
 * The only environment names Vostivo recognizes. Keeping this a closed set
 * (rather than a free-form string) makes it impossible for config code to
 * silently accept a typo'd environment name and fall through to defaults.
 */
export const ENVIRONMENTS = ["local", "development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function isProduction(env: Environment): boolean {
  return env === "production";
}
