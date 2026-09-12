import { describe, expect, it } from "vitest";
import {
  applyReferenceFilter,
  cycleFilterKey,
  EMPTY_FILTER,
  filterCandidates,
  groupLinkedReferences,
  groupUnlinkedReferences,
  referencedKeys,
} from "./referenceGrouping.js";

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

  it('sort "name" orders pages alphabetically and keeps refs most-recent first within a page', () => {
    const groups = groupLinkedReferences(
      [
        { id: "z1", page: "Zeta", text: "x", updatedAt: "2026-09-10T00:00:00.000Z" },
        { id: "a1", page: "Alpha", text: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "a2", page: "Alpha", text: "new", updatedAt: "2026-02-01T00:00:00.000Z" },
      ],
      "name",
    );
    expect(groups.map((g) => g.page)).toEqual(["Alpha", "Zeta"]);
    expect(groups[0]?.refs.map((r) => r.id)).toEqual(["a2", "a1"]);
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

const refs = [
  { id: "b1", page: "2026-09-10", text: "met [[Aurora]] team about #q3 and [[Target]]" },
  { id: "b2", page: "Meetings", text: "[[Target]] review with [[aurora]] stakeholders" },
  { id: "b3", page: "Meetings", text: "[[Target]] is DONE #done" },
];

describe("referencedKeys", () => {
  it("is the source page plus every page ref and tag in the text, normalized", () => {
    expect(referencedKeys(refs[0] as (typeof refs)[number])).toEqual([
      "2026-09-10",
      "aurora",
      "target",
      "q3",
    ]);
  });
});

describe("filterCandidates", () => {
  it("counts each page once per ref, most-mentioned first, omitting the panel's own page", () => {
    expect(filterCandidates(refs, "target")).toEqual([
      { key: "aurora", name: "Aurora", count: 2 },
      { key: "meetings", name: "Meetings", count: 2 },
      { key: "2026-09-10", name: "2026-09-10", count: 1 },
      { key: "done", name: "done", count: 1 },
      { key: "q3", name: "q3", count: 1 },
    ]);
  });

  it("folds [[Aurora]] and [[aurora]] into one candidate under the first spelling seen", () => {
    const [aurora] = filterCandidates(refs, "target");
    expect(aurora?.name).toBe("Aurora");
  });
});

describe("applyReferenceFilter", () => {
  it("returns everything for an empty filter", () => {
    expect(applyReferenceFilter(refs, EMPTY_FILTER).map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("include requires every listed page (AND)", () => {
    expect(
      applyReferenceFilter(refs, { include: ["aurora"], exclude: [] }).map((r) => r.id),
    ).toEqual(["b1", "b2"]);
    expect(
      applyReferenceFilter(refs, { include: ["aurora", "q3"], exclude: [] }).map((r) => r.id),
    ).toEqual(["b1"]);
  });

  it("exclude rejects any listed page (OR), and wins over include", () => {
    expect(applyReferenceFilter(refs, { include: [], exclude: ["done"] }).map((r) => r.id)).toEqual(
      ["b1", "b2"],
    );
    expect(
      applyReferenceFilter(refs, { include: ["meetings"], exclude: ["done"] }).map((r) => r.id),
    ).toEqual(["b2"]);
  });
});

describe("cycleFilterKey", () => {
  it("goes off -> included -> excluded -> off without mutating", () => {
    const a = cycleFilterKey(EMPTY_FILTER, "aurora");
    expect(a).toEqual({ include: ["aurora"], exclude: [] });
    const b = cycleFilterKey(a, "aurora");
    expect(b).toEqual({ include: [], exclude: ["aurora"] });
    const c = cycleFilterKey(b, "aurora");
    expect(c).toEqual({ include: [], exclude: [] });
    expect(EMPTY_FILTER).toEqual({ include: [], exclude: [] });
  });
});
