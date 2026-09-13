import { describe, expect, it } from "vitest";
import { aliasKeysOf, refKeyOf } from "./page-alias.js";

describe("aliasKeysOf", () => {
  it("reads the shapes real graphs carry: bare, [[wrapped]], #tagged, mixed case, repeats", () => {
    // The owner's graph has `alias:: zahrada, Zahrada, garden` on `Garden` and a `[[…]]`-wrapped
    // alias on an imported highlights page.
    expect(aliasKeysOf("zahrada, Zahrada, garden", "garden")).toEqual(["zahrada"]);
    expect(aliasKeysOf("[[The Logic of Tests, Particularly]]", "x")).toEqual([
      "the logic of tests, particularly",
    ]);
    expect(aliasKeysOf("#Nick, [[Other Name]]", "real")).toEqual(["nick", "other name"]);
  });

  it("drops empties and the page's own key; nothing for no value", () => {
    expect(aliasKeysOf(" , Real, ", "real")).toEqual([]);
    expect(aliasKeysOf(null, "real")).toEqual([]);
    expect(aliasKeysOf(undefined, "real")).toEqual([]);
  });

  it("folds a journal date in any title format to its ISO key, like a reference", () => {
    // (Bracketed: a bare `Sep 7th, 2026` is two list items, as it is in `tags::`.)
    expect(aliasKeysOf("[[Sep 7th, 2026]]", "x")).toEqual(["2026-09-07"]);
    expect(refKeyOf("  Daně ")).toBe("daně");
  });
});
