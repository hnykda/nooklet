import { describe, expect, it } from "vitest";
import { groupLinkedReferences, groupUnlinkedReferences } from "./referenceGrouping.js";

describe("groupLinkedReferences", () => {
  it("groups refs by page, most-recently-updated page first", () => {
    const groups = groupLinkedReferences([
      { id: "b1", page: "Old Page", text: "mentions it", updatedAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "b2",
        page: "New Page",
        text: "also mentions it",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
      { id: "b3", page: "Old Page", text: "again", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(groups.map((g) => g.page)).toEqual(["New Page", "Old Page"]);
    expect(groups[0]?.refs.map((r) => r.id)).toEqual(["b2"]);
    // Within "Old Page", refs are most-recently-updated first too (b3 before b1).
    expect(groups[1]?.refs.map((r) => r.id)).toEqual(["b3", "b1"]);
  });

  it("uses a page's single most-recent ref to rank it, even if interleaved with other pages", () => {
    const groups = groupLinkedReferences([
      { id: "a1", page: "A", text: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b1", page: "B", text: "x", updatedAt: "2026-01-05T00:00:00.000Z" },
      { id: "a2", page: "A", text: "y", updatedAt: "2026-01-10T00:00:00.000Z" }, // makes A more recent than B
    ]);
    expect(groups.map((g) => g.page)).toEqual(["A", "B"]);
  });

  it("returns nothing for no refs", () => {
    expect(groupLinkedReferences([])).toEqual([]);
  });

  it("breaks ties on page name for determinism", () => {
    const groups = groupLinkedReferences([
      { id: "z1", page: "Zeta", text: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", page: "Alpha", text: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(groups.map((g) => g.page)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("groupUnlinkedReferences", () => {
  it("groups by page alphabetically (no recency signal available)", () => {
    const groups = groupUnlinkedReferences([
      { id: "b1", page: "Zeta", text: "mentions the name in passing" },
      { id: "b2", page: "Alpha", text: "also mentions it" },
      { id: "b3", page: "Alpha", text: "and again" },
    ]);
    expect(groups.map((g) => g.page)).toEqual(["Alpha", "Zeta"]);
    expect(groups[0]?.refs.map((r) => r.id)).toEqual(["b2", "b3"]);
  });

  it("returns nothing for no mentions", () => {
    expect(groupUnlinkedReferences([])).toEqual([]);
  });
});
