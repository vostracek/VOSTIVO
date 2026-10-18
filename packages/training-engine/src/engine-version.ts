/**
 * Identifies the exact (engine, policy) pair that produced a decision.
 *
 * Hard rule (architecture): same input + same EngineVersion must always
 * produce the same output. When engine logic or policy changes in a way
 * that could change output for existing input, bump the version rather
 * than mutating behavior under an existing version — this keeps historical
 * decisions explainable/reproducible.
 */
export interface EngineVersion {
  readonly engine: string;
  readonly policy: string;
}

export function formatEngineVersion(version: EngineVersion): string {
  return `${version.engine}@${version.policy}`;
}

export function engineVersionsEqual(a: EngineVersion, b: EngineVersion): boolean {
  return a.engine === b.engine && a.policy === b.policy;
}
