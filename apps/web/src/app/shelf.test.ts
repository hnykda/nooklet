import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The active graph id as bootstrap would report it; the shelf module reads it at import.
let activeId: string | undefined;
vi.mock("../data/bootstrap.js", () => ({ activeGraphId: () => activeId }));

describe("shelf persistence key", () => {
  // Transform `shelf.js` and everything it imports once, outside any test's 5 s timeout. The
  // first test's `import()` paid for it: 0.6 s alone, 1.0 s in the web suite beside an e2e run,
  // against 4 ms for the second test, which re-imports the same files after `resetModules` — so
  // under the load of `pnpm -r test` next to an e2e client build the first test alone timed out
  // (B-669). Module state still starts fresh in each test (`resetModules` below).
  beforeAll(async () => {
    await import("./shelf.js");
  });
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });
  afterEach(() => {
    activeId = undefined;
  });

  // A tab's first load imports the shelf before bootstrap has adopted a graph. The key used to be
  // fixed at "~" then, so the next load (which has an id) found an empty shelf — red in
  // `e2e/tests/views.spec.ts` "a shelf card's crumb…" since `c58ede4`.
  it("a shelf made before bootstrap set the graph survives the next load", async () => {
    activeId = undefined;
    const first = await import("./shelf.js");
    activeId = "g1"; // bootstrap adopts the graph after the module has loaded
    first.openOnShelf({ kind: "page", name: "Kept" });

    vi.resetModules();
    const second = await import("./shelf.js");
    expect(second.shelfItems().map((i) => i.key)).toEqual(["page:kept"]);
  });

  it("keeps each graph's shelf to itself", async () => {
    activeId = "g1";
    const a = await import("./shelf.js");
    a.openOnShelf({ kind: "page", name: "Only In One" });

    vi.resetModules();
    activeId = "g2";
    const b = await import("./shelf.js");
    expect(b.shelfItems()).toEqual([]);
  });
});
