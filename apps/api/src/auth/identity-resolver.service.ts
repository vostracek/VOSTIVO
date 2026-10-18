import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@vostivo/database";
import type { AuthProvider } from "@vostivo/domain";
import { DATABASE } from "../database/database.module.js";
import { resolveOrCreateIdentity, type ResolvedIdentity } from "./identity-resolution.js";

@Injectable()
export class IdentityResolverService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  resolve(provider: AuthProvider, providerSubject: string): Promise<ResolvedIdentity> {
    return resolveOrCreateIdentity(this.db, provider, providerSubject);
  }
}
