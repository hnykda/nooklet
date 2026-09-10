import { describe, expect, it } from "vitest";
import { idTime, isId, isUuid, newId } from "./ids.js";

describe("ids", () => {
  it("generates valid, time-ordered, unique 14-char ids", () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isId(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it("encodes the creation time", () => {
    const t = Date.now() + 1_000_000_000; // ahead of the generator's clock, so encoded exactly
    const id = newId(t);
    expect(idTime(id)).toBe(t);
    expect(idTime(newId(t - 5000))).toBeGreaterThanOrEqual(t); // never goes backwards
    expect(id).toHaveLength(14);
  });

  it("recognizes Logseq's v4 uuids separately", () => {
    expect(isUuid("64f1a2b3-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isId("64f1a2b3-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isId("1k7f3q9xz2hav4")).toBe(true);
    expect(isId("1k7f3q9xz2havi")).toBe(false);
  });
});
