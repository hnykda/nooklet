import { describe, expect, it, vi } from "vitest";
import { pageNameToPath, pageZoomRoutePath, pathToPageName } from "../routes/page-path.js";
import { goToTarget } from "./navigateTarget.js";

vi.mock("../data/store.js", () => ({
  resolveBlockPageName: vi.fn(async (id: string) =>
    id === "known" ? "Projects/Aurora" : undefined,
  ),
}));

describe("pageNameToPath / pathToPageName", () => {
  it("round-trips a plain name", () => {
    expect(pathToPageName(pageNameToPath("Aurora"))).toBe("Aurora");
  });

  it("keeps namespace '/' as real path segments", () => {
    expect(pageNameToPath("Projects/Aurora")).toBe("Projects/Aurora");
  });

  it("encodes spaces and unicode per segment, round-tripping through a namespace path", () => {
    const name = "Projects/Aurora Launch/Čapek";
    expect(pathToPageName(pageNameToPath(name))).toBe(name);
  });

  // Names from real graphs (quotes, apostrophes, Czech) and the characters a URL gives meaning to:
  // a raw "?" or "#" in a segment would end the path there, and a raw "%" would not decode. What
  // the router reads is the path AFTER the browser has parsed the URL, so that is what is checked.
  it.each([
    "TTRPG/VTM-alpha/Isabella D'Angelo",
    'hypothesis__/Bayesian "Epistemology"',
    "Projekty/Příliš žluťoučký kůň",
    "Deals/50% off",
    "Questions/What? #1",
    "Literal/a%2Fb",
  ])("%s survives the browser's URL parser, with a zoom query after it", (name) => {
    const url = new URL(pageZoomRoutePath(name, "blk-1"), "http://127.0.0.1");
    expect(url.pathname).not.toMatch(/%2F/i);
    expect(pathToPageName(url.pathname.slice("/page/".length))).toBe(name);
    expect(url.searchParams.get("block")).toBe("blk-1");
    expect(url.hash).toBe("");
  });
});

describe("goToTarget", () => {
  it("navigates straight to a page target", async () => {
    const navigate = vi.fn();
    await goToTarget(navigate, { kind: "page", name: "Projects/Aurora" });
    expect(navigate).toHaveBeenCalledWith("/page/Projects/Aurora");
  });

  it("resolves a block target's page, then navigates with ?block=", async () => {
    const navigate = vi.fn();
    await goToTarget(navigate, { kind: "block", id: "known" });
    expect(navigate).toHaveBeenCalledWith("/page/Projects/Aurora?block=known");
  });

  it("does nothing when the block cannot be resolved locally", async () => {
    const navigate = vi.fn();
    await goToTarget(navigate, { kind: "block", id: "missing" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
