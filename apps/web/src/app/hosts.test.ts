/**
 * `createNavigationHost#followLink` (Alt+Enter, `nav.followLink`) for URL links: what reaches
 * `window.open`.
 *
 * - An asset path opens from the API origin's `/assets/` route, like the rendered `<a>` does —
 *   raw, `window.open` resolved `assets/x.pdf` against the current `/page/...` URL and the SPA
 *   fallback answered with index.html (B-137, the keyboard path of B-51).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/bootstrap.js", () => ({ apiBaseUrl: () => "http://api.test:6100" }));
vi.mock("../data/store.js", () => ({}));
vi.mock("../db/client.js", () => ({}));
vi.mock("../live/flash-bus.js", () => ({}));
vi.mock("../live/resolve-page-ref.js", () => ({}));

const open = vi.fn();
vi.stubGlobal("window", { open });

import { createNavigationHost } from "./hosts.js";

function host() {
  return createNavigationHost({ navigate: vi.fn(), pageNameForId: async () => undefined });
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
