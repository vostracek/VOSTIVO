import type { FastifyInstance } from "fastify";
import { CORRELATION_ID_HEADER, createCorrelationId } from "@vostivo/observability";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Every request gets a correlation id — from the incoming header if the
 * caller already has one (e.g. propagated from mobile's offline outbox),
 * otherwise freshly generated. Echoed back so a client can correlate its
 * own logs with server-side logs/error responses.
 *
 * Registered as a native Fastify `onRequest` hook rather than a Nest
 * `NestMiddleware` — under `FastifyAdapter`, Nest's cross-platform
 * middleware layer receives the *raw* Node `req`/`res`, not the wrapped
 * `FastifyRequest`/`FastifyReply` (no `.header()`, and anything attached to
 * the raw object is invisible to the real `FastifyRequest` controllers and
 * exception filters see). A real Fastify hook avoids that mismatch.
 */
export function registerCorrelationIdHook(fastify: FastifyInstance): void {
  fastify.decorateRequest("correlationId", "");

  fastify.addHook("onRequest", (request, reply, done) => {
    const incoming = request.headers[CORRELATION_ID_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) ?? createCorrelationId();

    request.correlationId = correlationId;
    void reply.header(CORRELATION_ID_HEADER, correlationId);
    done();
  });
}
