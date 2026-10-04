// @vitest-environment jsdom
// (`@solidjs/router` stamps `history.state` when it is imported.)
import { describe, expect, it } from "vitest";
import { readHistoryPosition } from "./history-position.js";

describe("readHistoryPosition (B-649)", () => {
  it("uses the Navigation API when the engine has it", () => {
    expect(
      readHistoryPosition({
        navigation: { canGoBack: false, canGoForward: true },
        depth: 5,
        length: 9,
      }),
    ).toEqual({ canGoBack: false, canGoForward: true });
  });

  it("falls back to the router's `_depth` stamp against history.length", () => {
    // First entry of a fresh app: nowhere to go either way.
    expect(readHistoryPosition({ depth: 0, length: 1 })).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
    // Two pages in, at the newest: back only.
    expect(readHistoryPosition({ depth: 2, length: 3 })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
    // After going back once: both.
    expect(readHistoryPosition({ depth: 1, length: 3 })).toEqual({
      canGoBack: true,
      canGoForward: true,
    });
  });

  it("enables both rather than locking the user in when there is no stamp", () => {
    expect(readHistoryPosition({ depth: undefined, length: 4 })).toEqual({
      canGoBack: true,
      canGoForward: true,
    });
  });
});
