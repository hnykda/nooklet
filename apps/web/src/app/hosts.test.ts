/**
 * `createNavigationHost#followLink` (Alt+Enter, `nav.followLink`).
 *
 * - An asset path opens from the API origin's `/assets/` route, like the rendered `<a>` does —
 *   raw, `window.open` resolved `assets/x.pdf` against the current `/page/...` URL and the SPA
 *   fallback answered with index.html (B-137, the keyboard path of B-51).
 * - A `((block ref))` zooms to the block on its page. Its page is looked up by BLOCK id; the host's
 *   `pageNameForId` takes a PAGE id (B-82), so asking it about a block found nothing (B-139).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/bootstrap.js", () => ({ apiBaseUrl: () => "http://api.test:6100" }));
vi.mock("../data/store.js", () => ({
  resolveBlockPageName: async (id: string) =>
    id === "blk00000000001" ? "Projects/Aurora" : undefined,
}));
vi.mock("../db/client.js", () => ({}));
vi.mock("../live/flash-bus.js", () => ({}));
vi.mock("../live/resolve-page-ref.js", () => ({}));

const open = vi.fn();
vi.stubGlobal("window", { open });

import { createNavigationHost } from "./hosts.js";

const navigate = vi.fn();

function host() {
  // Like the real wiring (`store.ts#resolvePageName`): knows page ids, not block ids.
  return createNavigationHost({
    navigate,
    pageNameForId: async (id) => (id === "pg000000000001" ? "Projects/Aurora" : undefined),
  });
}

describe("nav.followLink for URL links", () => {
  beforeEach(() => open.mockReset());

  it.each([
    ["assets/spec.pdf"],
    ["../assets/spec.pdf"],
    ["./assets/spec.pdf"],
    ["/assets/spec.pdf"],
  ])("opens the asset %s from the API origin", (href) => {
    host().followLink({ type: "url", href });
    expect(open).toHaveBeenCalledWith("http://api.test:6100/assets/spec.pdf", "_blank", "noopener");
  });

  it("opens an ordinary web link as written", () => {
    host().followLink({ type: "url", href: "https://example.com/a?b=c#d" });
    expect(open).toHaveBeenCalledWith("https://example.com/a?b=c#d", "_blank", "noopener");
  });
});

describe("nav.followLink for block refs", () => {
  beforeEach(() => navigate.mockReset());

  it("zooms to the referenced block on its page", async () => {
    host().followLink({ type: "block", id: "blk00000000001" });
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/page/Projects/Aurora?block=blk00000000001"),
    );
  });

  it("goes nowhere for a block the replica does not have", async () => {
    host().followLink({ type: "block", id: "blk-missing" });
    await new Promise((r) => setTimeout(r, 10));
    expect(navigate).not.toHaveBeenCalled();
  });
});
