import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedActor } from "./authenticated-actor.js";

/**
 * Reads the actor `AuthGuard` already resolved from trusted server
 * request context — handlers never parse a JWT or accept a
 * client-provided identity as authority (spec section 19).
 */
export const CurrentActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedActor => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (request.actor === undefined) {
      throw new Error("@CurrentActor() used on a route without AuthGuard");
    }
    return request.actor;
  },
);
