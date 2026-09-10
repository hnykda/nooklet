import { describe, expect, it } from "vitest";
import { isUuid, newId } from "./ids.js";

describe("ids", () => {
  it("generates valid, time-ordered, unique UUIDv7s", () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isUuid(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]?.[14]).toBe("7");
  });

  it("accepts Logseq's v4 ids", () => {
    expect(isUuid("64f1a2b3-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
