import { describe, expect, it } from "vitest";
import { readUnverifiedJwtSubject } from "./jwt-subject";
import { devToken } from "./testing/fakes";

describe("readUnverifiedJwtSubject — a lookup hint, never authorization", () => {
  it("reads the sub claim of a JWT-shaped token", () => {
    expect(readUnverifiedJwtSubject(devToken("subject-a"))).toBe("subject-a");
  });

  it("returns null for anything without a readable non-empty subject", () => {
    expect(readUnverifiedJwtSubject("not-a-jwt")).toBeNull();
    expect(readUnverifiedJwtSubject("a.b")).toBeNull();
    expect(readUnverifiedJwtSubject("a.%%%.c")).toBeNull();
    expect(readUnverifiedJwtSubject(devToken(""))).toBeNull();
  });
});
