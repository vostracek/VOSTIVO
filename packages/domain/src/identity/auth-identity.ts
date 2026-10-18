import type { EntityId } from "../entity-id.js";
import type { UserId } from "./user.js";

export type AuthIdentityId = EntityId<"AuthIdentity">;

/**
 * External authentication providers Vostivo trusts to answer "who are
 * you?". Modeled as an extensible set even though only Supabase exists
 * today, since `AuthIdentity` is specifically the join between an external
 * provider's subject and a Vostivo `User` — a second provider must not
 * require a schema change, only a new enum member.
 */
export const AUTH_PROVIDERS = ["supabase"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/**
 * The external identity is deliberately a separate entity from `User`
 * (spec section 5) — a `User` may in the future gain more than one linked
 * provider, and the external subject is never itself the canonical
 * identity key (spec section 13: email/subject are not identity).
 */
export interface AuthIdentity {
  readonly id: AuthIdentityId;
  readonly userId: UserId;
  readonly provider: AuthProvider;
  readonly providerSubject: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}
