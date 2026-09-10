import { describe, expect, it } from "vitest";
import { rrfFuse } from "./rrf.js";

describe("rrfFuse", () => {
  it("is deterministic for the same inputs", () => {
    const a = rrfFuse(["x", "y", "z"], ["y", "x"]);
    const b = rrfFuse(["x", "y", "z"], ["y", "x"]);
    expect(a).toEqual(b);
  });

  it("ranks an id appearing at the top of both lists highest", () => {
    const fused = rrfFuse(["a", "b", "c"], ["a", "c", "b"]);
    expect(fused[0]?.id).toBe("a");
  });

  it("scores match the k=60 formula (default weights 1.25 fts / 1.0 vec)", () => {
    const fused = rrfFuse(["a"], ["a"]);
    const expected = 1.25 / (60 + 1) + 1.0 / (60 + 1);
    expect(fused[0]?.score).toBeCloseTo(expected, 10);
    expect(fused[0]?.ftsRank).toBe(1);
    expect(fused[0]?.vecRank).toBe(1);
  });

  it("gives an id present in only one list a score from that list alone", () => {
    const fused = rrfFuse(["a", "b"], ["c"]);
    const byId = new Map(fused.map((f) => [f.id, f]));
    expect(byId.get("b")?.score).toBeCloseTo(1.25 / (60 + 2), 10);
    expect(byId.get("b")?.vecRank).toBeUndefined();
    expect(byId.get("c")?.score).toBeCloseTo(1.0 / (60 + 1), 10);
    expect(byId.get("c")?.ftsRank).toBeUndefined();
  });

  it("respects a custom k and weights", () => {
    const fused = rrfFuse(["a"], ["a"], { k: 1, wFts: 2, wVec: 3 });
    expect(fused[0]?.score).toBeCloseTo(2 / 2 + 3 / 2, 10);
  });

  it("returns results sorted best-first", () => {
    const fused = rrfFuse(["a", "b", "c", "d"], ["d", "c"]);
    const scores = fused.map((f) => f.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] as number);
    }
  });

  it("handles two empty lists without throwing", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
