import { describe, expect, it } from "vitest";
import { countLabel, firstRows } from "./referenceWindow.js";

const group = (page: string, n: number) => ({
  page,
  refs: Array.from({ length: n }, (_, i) => ({ id: `${page}-${i}` })),
});

describe("firstRows", () => {
  it("keeps whole groups while they fit and cuts the one the limit falls in", () => {
    const w = firstRows([group("a", 3), group("b", 4), group("c", 2)], 5);
    expect(w.groups.map((g) => [g.page, g.refs.length])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(w.shown).toBe(5);
    expect(w.total).toBe(9);
  });

  it("shows everything when the limit is at or above the total", () => {
    const groups = [group("a", 2), group("b", 1)];
    const w = firstRows(groups, 3);
    expect(w.groups).toEqual(groups);
    expect(w.shown).toBe(3);
    expect(w.total).toBe(3);
  });

  it("does not mutate the groups it cuts", () => {
    const b = group("b", 4);
    firstRows([b], 1);
    expect(b.refs).toHaveLength(4);
  });
});

describe("countLabel", () => {
  it("adds a plus only to a partial count", () => {
    expect(countLabel(50, false)).toBe("50");
    expect(countLabel(500, true)).toBe("500+");
  });
});
