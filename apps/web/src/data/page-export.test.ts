import { describe, expect, it, vi } from "vitest";

// `page-export.ts` imports the worker client; these tests exercise only the pure helper, so the
// worker is never started.
vi.mock("../db/client.js", () => ({ queryAs: vi.fn() }));

const { isFavoriteValue } = await import("./page-export.js");

describe("isFavoriteValue", () => {
  // The sidebar's Favourites query is `value NOT IN ('', 'false')` (`store.ts#useFavoritePages`);
  // the star on the page must agree with it for every stored value, or a page can be starred and
  // missing from the list (or listed with an empty star).
  it.each([
    ["true", true],
    ["yes", true],
    ["False", true],
    ["false", false],
    ["", false],
    [null, false],
    [undefined, false],
  ] as const)("%j -> %s", (value, expected) => {
    expect(isFavoriteValue(value)).toBe(expected);
  });
});
