import { describe, expect, it } from "vitest";
import { asEntityId, createEntityId } from "./entity-id.js";
import { DomainError } from "./domain-error.js";
import { err, isErr, isOk, ok } from "./result.js";
import { createDomainEvent } from "./domain-event.js";
import { ValueObject } from "./value-object.js";

class TestDomainError extends DomainError {
  readonly code = "TEST_ERROR";
}

class Money extends ValueObject<{ amount: number; currency: string }> {
  static of(amount: number, currency: string): Money {
    return new Money({ amount, currency });
  }
}

describe("domain package has no framework dependency", () => {
  it("creates a unique, brandable entity id", () => {
    const idA = createEntityId<"Athlete">();
    const idB = createEntityId<"Athlete">();
    expect(idA).not.toEqual(idB);
    expect(asEntityId<"Athlete">("known-id")).toBe("known-id");
  });

  it("distinguishes DomainError from a plain infrastructure error", () => {
    const error = new TestDomainError("something violated a rule");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("TEST_ERROR");
    expect(error.name).toBe("TestDomainError");
  });

  it("models expected failure with Result instead of throwing", () => {
    const success = ok(42);
    const failure = err("not found");
    expect(isOk(success) && success.value).toBe(42);
    expect(isErr(failure) && failure.error).toBe("not found");
  });

  it("creates a timestamped domain event envelope", () => {
    const event = createDomainEvent("athlete.created", { athleteId: "a-1" });
    expect(event.name).toBe("athlete.created");
    expect(event.occurredAt).toBeInstanceOf(Date);
  });

  it("compares value objects structurally, not by identity", () => {
    const a = Money.of(10, "EUR");
    const b = Money.of(10, "EUR");
    const c = Money.of(11, "EUR");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a).not.toBe(b);
  });
});
