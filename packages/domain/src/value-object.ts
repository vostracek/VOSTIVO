/**
 * Base for immutable value objects compared by structural equality rather
 * than identity. Kept intentionally tiny — concrete value objects (e.g. a
 * future WeightKg or RepRange) will extend this as the domain grows.
 */
export abstract class ValueObject<Props extends Record<string, unknown>> {
  protected constructor(protected readonly props: Readonly<Props>) {}

  equals(other: ValueObject<Props> | undefined | null): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
