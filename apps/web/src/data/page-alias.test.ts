import { describe, expect, it, vi } from "vitest";
import { pickAliasedPage } from "./page-alias.js";

// The replica query is exercised end to end (`e2e/tests/page-identity.spec.ts`); this is the pick.
vi.mock("../db/client.js", () => ({ queryAs: vi.fn() }));

const rows = [
  // The owner's real shapes: a repeated, differently-cased list, and a [[wrapped]] alias.
  { id: "p1", key: "garden", alias_value: "zahrada, Zahrada, garden" },
  { id: "p2", key: "taxes", alias_value: "daně" },
  { id: "p3", key: "hls__logic", alias_value: "[[The Logic of Tests, Particularly]]" },
  { id: "p4", key: "second", alias_value: "zahrada" },
];

describe("pickAliasedPage (B-104)", () => {
  it("matches case- and space-insensitively, diacritics kept", () => {
    expect(pickAliasedPage(rows, "Zahrada")?.id).toBe("p1");
    expect(pickAliasedPage(rows, " DANĚ ")?.id).toBe("p2");
    expect(pickAliasedPage(rows, "dane")).toBeNull();
  });

  it("reads a [[wrapped]] alias with a comma inside as one name", () => {
    expect(pickAliasedPage(rows, "The Logic of Tests, Particularly")?.id).toBe("p3");
    expect(pickAliasedPage(rows, "The Logic of Tests")).toBeNull();
  });

  it("never matches a page by its own key, and the first claimant of a contested alias wins", () => {
    // `garden` is p1's own key, which aliasKeysOf drops — the own-key lookup runs before this.
    expect(pickAliasedPage(rows, "garden")).toBeNull();
    expect(pickAliasedPage(rows, "zahrada")?.id).toBe("p1");
    expect(pickAliasedPage(rows, "")).toBeNull();
  });
});
