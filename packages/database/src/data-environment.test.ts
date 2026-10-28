import { describe, expect, it } from "vitest";
import {
  assertDataEnvironmentMatches,
  assertNotDogfoodTarget,
  DataEnvironmentMismatchError,
  DOGFOOD_DATABASE_MARKER,
} from "./data-environment.js";

const DOGFOOD = { databaseName: "vostivo_dogfood", marker: DOGFOOD_DATABASE_MARKER };

describe("assertDataEnvironmentMatches — declared env, database name and marker must agree both ways", () => {
  it("DOGFOOD-ENV-001: dogfood process + dogfood database with marker -> ok", () => {
    expect(() => assertDataEnvironmentMatches("dogfood", DOGFOOD)).not.toThrow();
  });

  it("DOGFOOD-ENV-002: dogfood process against a non-dogfood database is refused", () => {
    expect(() => assertDataEnvironmentMatches("dogfood", { databaseName: "vostivo_dev", marker: null })).toThrow(DataEnvironmentMismatchError);
    expect(() => assertDataEnvironmentMatches("dogfood", { databaseName: "vostivo_manual", marker: null })).toThrow(DataEnvironmentMismatchError);
  });

  it("DOGFOOD-ENV-003: dogfood process against a dogfood-named database WITHOUT the marker is refused", () => {
    expect(() => assertDataEnvironmentMatches("dogfood", { databaseName: "vostivo_dogfood", marker: null })).toThrow(/no dogfood marker/);
  });

  it("DOGFOOD-ENV-004: a non-dogfood process (unset, dev, manual) is refused on the dogfood database", () => {
    for (const declared of [undefined, "dev", "manual"] as const) {
      expect(() => assertDataEnvironmentMatches(declared, DOGFOOD)).toThrow(DataEnvironmentMismatchError);
    }
  });

  it("DOGFOOD-ENV-005: a database carrying the dogfood marker under another name is still dogfood", () => {
    expect(() => assertDataEnvironmentMatches(undefined, { databaseName: "renamed", marker: DOGFOOD_DATABASE_MARKER })).toThrow(DataEnvironmentMismatchError);
  });

  it("DOGFOOD-ENV-006: ordinary dev/manual runs are unaffected", () => {
    expect(() => assertDataEnvironmentMatches(undefined, { databaseName: "vostivo_dev", marker: null })).not.toThrow();
    expect(() => assertDataEnvironmentMatches("manual", { databaseName: "vostivo_manual", marker: null })).not.toThrow();
  });
});

describe("assertNotDogfoodTarget — tests and dev tooling never touch dogfood", () => {
  it("DOGFOOD-TEST-001: refuses any DB URL naming vostivo_dogfood", () => {
    for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "MANUAL_DATABASE_URL"]) {
      expect(() => assertNotDogfoodTarget({ [key]: "postgres://u:p@127.0.0.1:5433/vostivo_dogfood" }, "integration tests")).toThrow(DataEnvironmentMismatchError);
    }
  });

  it("DOGFOOD-TEST-002: refuses VOSTIVO_DATA_ENV=dogfood even with a dev URL", () => {
    expect(() => assertNotDogfoodTarget({ VOSTIVO_DATA_ENV: "dogfood", DATABASE_URL: "postgres://u:p@localhost:5432/vostivo_dev" }, "integration tests")).toThrow(DataEnvironmentMismatchError);
  });

  it("DOGFOOD-TEST-003: the default (unset) and the dev database are allowed; the message never echoes the URL", () => {
    expect(() => assertNotDogfoodTarget({}, "integration tests")).not.toThrow();
    expect(() => assertNotDogfoodTarget({ DATABASE_URL: "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev" }, "integration tests")).not.toThrow();
    expect(() => assertNotDogfoodTarget({ DATABASE_URL: "postgres://u:SECRET@127.0.0.1:5433/vostivo_dogfood" }, "integration tests")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("SECRET") as unknown }),
    );
  });
});
