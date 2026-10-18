import { z } from "zod";
import { baseConfigSchema, loadConfig } from "@vostivo/config";

export const apiConfigSchema = baseConfigSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  // The Supabase project base URL, e.g. https://<project-ref>.supabase.co —
  // used to derive both the JWKS endpoint and the expected `iss` claim.
  // No secret/service-role key is ever read here (spec section 24).
  SUPABASE_URL: z.string().url(),
  // Rate limiting (Security Hardening Follow-Up V1) — a generous,
  // environment-configurable in-memory-per-instance baseline, not a
  // distributed limit. Defaults sized for realistic V1 mobile traffic
  // (Plan reads, Workout Preview, /me, sync reconnect/retry bursts) — see
  // docs/audits/V1-ENGINEERING-SECURITY-BASELINE.md's "Rate limiting"
  // section for the full reasoning.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Fastify's `trustProxy` option governs which `X-Forwarded-*` headers
  // are honored when deriving `request.ip` (what the rate limiter keys
  // on by default). Defaults to `false` — the safe default when the real
  // production reverse-proxy topology is not yet known (see the fastify
  // advisory on X-Forwarded-* spoofing under a misconfigured trustProxy
  // hop-count) — never trusting a client-supplied header until a real
  // deployment topology is chosen and this is deliberately reconfigured.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Local Manual E2E Runtime Unblock Slice - a filesystem path to a
  // locally-generated JWKS JSON file (see
  // apps/api/src/dev/generate-local-auth-key.ts), used ONLY so AuthModule
  // can verify a locally-minted dev JWT without a real Supabase project.
  // Optional and unset by default; the superRefine below makes it
  // impossible for this to activate outside NODE_ENV=local even if the
  // variable happens to be present in a development/staging/production
  // environment's config.
  LOCAL_JWKS_PATH: z.string().optional(),
}).superRefine((config, ctx) => {
  if (config.LOCAL_JWKS_PATH !== undefined && config.NODE_ENV !== "local") {
    ctx.addIssue({
      code: "custom",
      path: ["LOCAL_JWKS_PATH"],
      message:
        "LOCAL_JWKS_PATH is set but NODE_ENV is not 'local' - refusing to start rather than " +
        "silently allowing a local development JWKS override outside local development.",
    });
  }
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return loadConfig(apiConfigSchema, source);
}
