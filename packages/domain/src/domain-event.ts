/**
 * Minimal domain event envelope primitive. Vostivo uses domain events where
 * useful alongside relational current-state + durable history — this is not
 * an event-sourcing system, so events are not the source of truth.
 */
export interface DomainEvent<Name extends string = string, Payload = unknown> {
  readonly name: Name;
  readonly occurredAt: Date;
  readonly payload: Payload;
}

export function createDomainEvent<Name extends string, Payload>(
  name: Name,
  payload: Payload,
  occurredAt: Date = new Date(),
): DomainEvent<Name, Payload> {
  return { name, occurredAt, payload };
}
