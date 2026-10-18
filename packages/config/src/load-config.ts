import { z } from "zod";
import { ENVIRONMENTS } from "./environment.js";

/**
 * Base schema shared by every service. A service extends this with its own
 * required variables via `schema.extend(...)`. Fails fast (throws) on
 * missing/invalid config rather than limping along with `undefined` — an
 * app should refuse to boot with broken config, not fail at request time.
 */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(ENVIRONMENTS).default("local"),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

export class ConfigValidationError extends Error {
  constructor(readonly issues: z.ZodError["issues"]) {
    super(`Invalid environment configuration: ${issues.map((i) => i.path.join(".")).join(", ")}`);
    this.name = "ConfigValidationError";
  }
}

/**
 * Loads and validates config from a raw source (defaults to `process.env`).
 * Never logs the raw source — only the (redacted) list of failing keys — so
 * secret values never end up in logs on a validation failure.
 */
export function loadConfig<Schema extends typeof baseConfigSchema>(
  schema: Schema,
  source: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }
  return result.data;
}
