import { describe, expect, it } from "vitest";
import { canonicalStringify, computeEvidenceFingerprint, type EvidenceFingerprintInput } from "./progression-fingerprint.js";

describe("canonicalStringify", () => {
  it("produces the same string for objects with different key insertion order", () => {
    const a = { b: 2, a: 1, c: { z: 3, y: 4 } };
    const b = { a: 1, c: { y: 4, z: 3 }, b: 2 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("preserves array order — never reorders semantically meaningful sequences", () => {
    expect(canonicalStringify([{ a: 1 }, { a: 2 }])).not.toBe(canonicalStringify([{ a: 2 }, { a: 1 }]));
  });

  it("is sensitive to a nested value actually changing", () => {
    const before = { exposures: [{ actualReps: 10 }] };
    const after = { exposures: [{ actualReps: 11 }] };
    expect(canonicalStringify(before)).not.toBe(canonicalStringify(after));
  });
});

/**
 * Slice C identity gate (2026-09-23) — proves cases A-D the tech lead
 * required, against the corrected fingerprint payload. See
 * `progression-fingerprint.ts`'s own doc comment for the two real gaps
 * this closed (revision-only correction; distinct source collision).
 */
describe("computeEvidenceFingerprint", () => {
  const base: EvidenceFingerprintInput = {
    engine: "progression",
    policy: "v1",
    userId: "user-1",
    sourceWorkoutSessionId: "session-1",
    sourcePerformedExerciseId: "performed-exercise-1",
    sourcePrescriptionExerciseId: "presc-ex-1",
    normalizedInputSnapshot: { exposures: [{ actualReps: 10 }] },
    evidenceRefs: [{ performedSetId: "set-1", revisionEvaluated: 1 }],
  };

  it("A: the exact same evaluation identity evaluated twice produces the SAME fingerprint", () => {
    expect(computeEvidenceFingerprint(base)).toBe(computeEvidenceFingerprint(base));
  });

  it("B: a revision-only correction (identical canonical values, different revision) produces a DIFFERENT fingerprint", () => {
    // The normalizedInputSnapshot is BYTE-IDENTICAL — only the evidence
    // ref's revisionEvaluated changed (a real reopen -> recomplete that
    // happened not to change actualReps/actualLoad). This is exactly the
    // case the original fingerprint payload got wrong.
    const revisionOnlyChange: EvidenceFingerprintInput = {
      ...base,
      evidenceRefs: [{ performedSetId: "set-1", revisionEvaluated: 2 }],
    };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(revisionOnlyChange));
  });

  it("C: two distinct sources with semantically identical normalized values produce DIFFERENT fingerprints", () => {
    // Same userId, same normalizedInputSnapshot, same evidenceRefs shape —
    // only the source workout/performed exercise identity differs. This is
    // exactly the case the original fingerprint payload collapsed.
    const differentSource: EvidenceFingerprintInput = {
      ...base,
      sourceWorkoutSessionId: "session-2",
      sourcePerformedExerciseId: "performed-exercise-2",
    };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(differentSource));
  });

  it("D: a different engine/policy version produces a DIFFERENT fingerprint", () => {
    const bumpedPolicy: EvidenceFingerprintInput = { ...base, policy: "v2" };
    const bumpedEngine: EvidenceFingerprintInput = { ...base, engine: "other-engine" };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(bumpedPolicy));
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(bumpedEngine));
  });

  it("changes when userId changes, even with byte-identical evidence (BOLA defense-in-depth)", () => {
    const otherUser: EvidenceFingerprintInput = { ...base, userId: "user-2" };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(otherUser));
  });

  it("changes when the normalized input snapshot changes (a rep/load value actually corrected)", () => {
    const corrected: EvidenceFingerprintInput = {
      ...base,
      normalizedInputSnapshot: { exposures: [{ actualReps: 11 }] },
    };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint(corrected));
  });

  it("evidenceRefs are canonically ordered — insertion order of the array does not affect the fingerprint", () => {
    const twoRefs: EvidenceFingerprintInput = {
      ...base,
      evidenceRefs: [
        { performedSetId: "set-2", revisionEvaluated: 1 },
        { performedSetId: "set-1", revisionEvaluated: 1 },
      ],
    };
    const sameRefsReordered: EvidenceFingerprintInput = {
      ...base,
      evidenceRefs: [
        { performedSetId: "set-1", revisionEvaluated: 1 },
        { performedSetId: "set-2", revisionEvaluated: 1 },
      ],
    };
    expect(computeEvidenceFingerprint(twoRefs)).toBe(computeEvidenceFingerprint(sameRefsReordered));
  });

  it("is unaffected by object key insertion order inside the snapshot", () => {
    const reordered: EvidenceFingerprintInput = {
      normalizedInputSnapshot: { exposures: [{ actualReps: 10 }] },
      userId: base.userId,
      engine: base.engine,
      policy: base.policy,
      sourceWorkoutSessionId: base.sourceWorkoutSessionId,
      sourcePerformedExerciseId: base.sourcePerformedExerciseId,
      sourcePrescriptionExerciseId: base.sourcePrescriptionExerciseId,
      evidenceRefs: base.evidenceRefs,
    };
    expect(computeEvidenceFingerprint(base)).toBe(computeEvidenceFingerprint(reordered));
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    expect(computeEvidenceFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
