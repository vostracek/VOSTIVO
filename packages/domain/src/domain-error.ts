/**
 * Base class for errors that represent a violation of a domain rule, as
 * opposed to an infrastructure failure (network, DB, etc). Application and
 * transport layers translate these into their own error contracts —
 * DomainError itself must stay transport-agnostic.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
