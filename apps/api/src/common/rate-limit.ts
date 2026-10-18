import rateLimit from "@fastify/rate-limit";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

export interface RateLimitConfig {
  readonly RATE_LIMIT_MAX: number;
  readonly RATE_LIMIT_WINDOW_SECONDS: number;
}

/**
 * Application-instance, in-memory rate limiting (Security Hardening
 * Follow-Up V1, "API rate limiting") — defense-in-depth against runaway
 * traffic, never an authorization mechanism. Explicitly NOT Redis/a
 * distributed store, per V1's no-new-infra constraint.
 *
 * **Known limitation, stated plainly**: this counts requests per Node
 * process. Running more than one API instance means each instance
 * enforces its own independent limit — a client could receive up to
 * `RATE_LIMIT_MAX` requests per instance, not per deployment. Horizontal
 * scaling beyond a single instance requires either a shared store (e.g.
 * Redis-backed `@fastify/rate-limit`) or enforcement at the ingress/
 * platform layer (e.g. a reverse proxy or PaaS-level rate limit) — a
 * decision to make once real hosting is chosen, not before.
 *
 * A single global rule (keyed by `request.ip`, `@fastify/rate-limit`'s
 * default) is used everywhere, including `/sync/workout-commands` — no
 * separate, lower per-route limit was added there. `RATE_LIMIT_MAX`'s
 * default (300/60s) already comfortably covers a full offline-reconnect
 * burst: a single sync request already batches up to 500 commands (the
 * DoS-hardening bound from the Engineering Quality & Security Baseline
 * Audit), so even a heavy catch-up sync needs very few *requests*, not
 * hundreds — a request-count limit and a command-count-per-request limit
 * are solving different problems and don't need to be conflated into one
 * route-specific override.
 */
export async function registerRateLimit(app: NestFastifyApplication, config: RateLimitConfig): Promise<void> {
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  });
}
