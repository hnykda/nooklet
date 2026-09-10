import { describe, expect, it } from "vitest";
import { createMruStore, type MruStore } from "./mru.js";
import { rankItems } from "./rank.js";

interface TestCommand {
  id: string;
  title: string;
}

function mruWith(entries: Array<{ kind: "command" | "page"; id: string }>): MruStore {
  const mru = createMruStore();
  // record() moves-to-front, so record in reverse so the FIRST listed entry ends up most recent.
  [...entries].reverse().forEach((e, i) => {
    mru.record(e.kind, e.id, i);
  });
  return mru;
}

describe("rankItems — the spec's worked example (R72-R73)", () => {
  const items: TestCommand[] = [
    { id: "app.toggleSidebar", title: "Toggle sidebar" },
    { id: "app.openSettings", title: "Open settings" },
    { id: "app.openPluginManager", title: "Open plugin manager" },
  ];
  const mru = mruWith([{ kind: "command", id: "app.openSettings" }]);

  it("empty query: MRU first, then registration order", () => {
    const ranked = rankItems({ query: "", items, mru, kind: "command" });
    expect(ranked.map((r) => r.item.id)).toEqual([
      "app.openSettings",
      "app.toggleSidebar",
      "app.openPluginManager",
    ]);
  });

  it('query "open": both prefix matches score equally, MRU breaks the tie; toggleSidebar ranks below both or is excluded', () => {
    const ranked = rankItems({ query: "open", items, mru, kind: "command" });
    const ids = ranked.map((r) => r.item.id);
    const openSettingsIdx = ids.indexOf("app.openSettings");
    const openPluginIdx = ids.indexOf("app.openPluginManager");
    expect(openSettingsIdx).toBeGreaterThanOrEqual(0);
    expect(openPluginIdx).toBeGreaterThan(openSettingsIdx);
    const toggleIdx = ids.indexOf("app.toggleSidebar");
    if (toggleIdx !== -1) {
      expect(toggleIdx).toBeGreaterThan(openPluginIdx);
    }
  });
});

describe("rankItems — fuzzy score is primary; recency only breaks a tie", () => {
  it("recency beats a raw-score difference too small to separate two equal prefix matches", () => {
    const items: TestCommand[] = [
      { id: "a.recent", title: "Open A" },
      { id: "b.older", title: "Open B" },
    ];
    const mru = mruWith([{ kind: "command", id: "a.recent" }]);
    const ranked = rankItems({ query: "open", items, mru, kind: "command" });
    expect(ranked[0]?.item.id).toBe("a.recent");
  });

  it("a clearly better textual match outranks recency (score is checked before MRU)", () => {
    const items: TestCommand[] = [
      { id: "scattered", title: "Sync everything now, please" }, // "sync" is scattered/non-contiguous
      { id: "exact", title: "Sync" }, // exact match
    ];
    const mru = mruWith([{ kind: "command", id: "scattered" }]);
    const ranked = rankItems({ query: "sync", items, mru, kind: "command" });
    // Even though "scattered" is more recently used, "exact" is a strictly better match and must
    // still win — recency never overrides a clearly better textual match (R73).
    expect(ranked[0]?.item.id).toBe("exact");
  });
});

describe("rankItems — exact prefix beats a scattered substring match", () => {
  it("ranks a prefix match above a same-letters-scattered match", () => {
    const items: TestCommand[] = [
      { id: "scattered", title: "Sidebar collapse, expand" }, // contains s,c,e scattered, not "sc"
      { id: "prefix", title: "Scroll to top" }, // starts with "sc"
    ];
    const mru = createMruStore(); // no MRU influence
    const ranked = rankItems({ query: "sc", items, mru, kind: "command" });
    expect(ranked[0]?.item.id).toBe("prefix");
  });
});

describe("rankItems — deterministic final tiebreaks (R73 (3)/(4))", () => {
  it("breaks a full tie (score + MRU) alphabetically by title, then id", () => {
    const items: TestCommand[] = [
      { id: "z.duplicate", title: "Same" },
      { id: "a.duplicate", title: "Same" },
    ];
    const mru = createMruStore();
    const ranked = rankItems({ query: "same", items, mru, kind: "command" });
    expect(ranked.map((r) => r.item.id)).toEqual(["a.duplicate", "z.duplicate"]);
  });
});

describe("rankItems — non-matches are excluded", () => {
  it("drops a candidate whose title doesn't fuzzy-match the query at all", () => {
    const items: TestCommand[] = [{ id: "a", title: "Toggle sidebar" }];
    const ranked = rankItems({
      query: "zzzznomatch",
      items,
      mru: createMruStore(),
      kind: "command",
    });
    expect(ranked).toEqual([]);
  });
});

describe("rankItems — aliases (pages)", () => {
  it("uses the better of title/alias score per candidate", () => {
    const items = [{ id: "p1", title: "Grocery List", aliases: ["Shopping"] }];
    const ranked = rankItems({ query: "shop", items, mru: createMruStore(), kind: "page" });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.item.id).toBe("p1");
  });
});

describe("rankItems — diacritic folding (R70) applies to matching too", () => {
  it("matches a diacritic-folded query against an accented title", () => {
    const items: TestCommand[] = [{ id: "p", title: "Čapek" }];
    const ranked = rankItems({ query: "capek", items, mru: createMruStore(), kind: "page" });
    expect(ranked).toHaveLength(1);
  });
});
