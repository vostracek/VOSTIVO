import { generateDomainId } from "./id-generator.js";

/**
 * A branded identifier for a domain entity. The brand prevents an id for one
 * entity type from being passed where an id for a different entity type is
 * expected, without needing a wrapper class per entity.
 *
 * Generation is centralized here as the single boundary for Vostivo domain
 * IDs — callers must never call a UUID library directly. IDs are UUIDv7
 * (time-ordered, globally unique, no auto-increment/sequence dependency),
 * not UUIDv4 — see adr/0006-uuidv7-domain-ids.md for why and how the
 * random source is supplied per platform.
 */
export type EntityId<Brand extends string> = string & { readonly __brand: Brand };

export function createEntityId<Brand extends string>(): EntityId<Brand> {
  return generateDomainId() as EntityId<Brand>;
}

export function asEntityId<Brand extends string>(value: string): EntityId<Brand> {
  return value as EntityId<Brand>;
}
