import { describe, expect, it, vi } from "vitest";
import { pageNameToPath, pathToPageName } from "../routes/page-path.js";
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
