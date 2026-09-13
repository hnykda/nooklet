/**
 * B-268, the keyboard half: "follow link at caret" handed a `url` link straight to
 * `window.open`, whatever its scheme.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigationHost } from "./hosts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NavigationHost.followLink", () => {
  it("opens web links and refuses javascript: ones", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const host = createNavigationHost({ navigate: () => {}, pageNameForId: async () => undefined });

    host.followLink({ type: "url", href: "https://example.com" });
    host.followLink({ type: "url", href: "javascript:document.title='PWNED'" });
    host.followLink({ type: "url", href: " JaVa\tScRiPt:alert(1)" });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener");
  });
});
