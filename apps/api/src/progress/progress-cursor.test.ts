import { describe, expect, it } from "vitest";
import { decodeProgressCursor, encodeProgressCursor } from "./progress-cursor.js";

const ID = "01a1500e-53a5-7982-8ca0-bd9cd06a95fb";

describe("progress cursor", () => {
  it("round-trips Postgres' microsecond timestamptz text exactly", () => {
    const cursor = { completedAt: "2026-10-13 09:00:00.000123+00", id: ID };
    expect(decodeProgressCursor(encodeProgressCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64 JSON", "%%%"],
    ["JSON without the fields", Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")],
    ["a non-UUID id", encodeProgressCursor({ completedAt: "2026-10-13 09:00:00+00", id: "1; drop table" })],
    ["a non-timestamp", encodeProgressCursor({ completedAt: "yesterday", id: ID })],
    ["an impossible date", encodeProgressCursor({ completedAt: "2026-02-31 09:00:00+00", id: ID })],
    ["an impossible hour", encodeProgressCursor({ completedAt: "2026-10-13 25:00:00+00", id: ID })],
  ])("rejects %s", (_label, raw) => {
    expect(decodeProgressCursor(raw)).toBeUndefined();
  });
});
