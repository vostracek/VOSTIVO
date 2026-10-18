import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { isUsableAccountStatus } from "@vostivo/domain";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "./token-verifier.js";
import { IdentityResolverService } from "./identity-resolver.service.js";
import type { AuthenticatedActor } from "./authenticated-actor.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

/**
 * Authentication + internal identity resolution, in one place, so
 * downstream handlers never parse a JWT or trust a client-supplied
 * identity (spec section 19). Any failure — missing token, malformed
 * token, bad signature, expired token — surfaces as a generic 401 via the
 * existing safe error envelope; verification internals are never exposed
 * (spec section 14, 22).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_TOKEN_VERIFIER) private readonly verifier: AuthTokenVerifier,
    private readonly identityResolver: IdentityResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const bearerToken = extractBearerToken(request.headers.authorization);
    if (bearerToken === null) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const principal = await this.verifier.verify(bearerToken).catch(() => {
      throw new UnauthorizedException("Invalid or expired token");
    });

    const identity = await this.identityResolver.resolve("supabase", principal.subject);

    // Authentication success does not imply a usable account (spec
    // section 17) — a suspended/deletion-pending/deleted user is denied
    // here, distinctly from an unauthenticated request.
    if (!isUsableAccountStatus(identity.userStatus)) {
      throw new ForbiddenException("Account is not active");
    }

    request.actor = { userId: identity.userId, athleteProfileId: identity.athleteProfileId };
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
    return null;
  }
  return token;
}
