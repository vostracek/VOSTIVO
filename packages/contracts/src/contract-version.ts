/**
 * Every versioned contract (API DTO, sync payload, ...) carries an explicit
 * version so producers/consumers can evolve independently and a receiver
 * can reject or migrate an unexpected shape instead of guessing.
 */
export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export function formatContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}`;
}

export function isCompatible(supported: ContractVersion, received: ContractVersion): boolean {
  return supported.major === received.major && received.minor <= supported.minor;
}
