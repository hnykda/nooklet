// @vitest-environment jsdom
/**
 * B-703: an image whose asset size is known gets its box before it loads; one whose size is not
 * (an external URL, an older server) renders as before. `asset.sizes` is faked at `callOp`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callOp = vi.fn();
vi.mock("../../data/api-client.js", () => ({ callOp: (...a: unknown[]) => callOp(...a) }));

const { resetAssetSizesForTest } = await import("../../data/asset-sizes.js");
const { BlockContentView } = await import("./tokens.js");

function renderContent(content: string) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content }} />);
}

beforeEach(() => {
  resetAssetSizesForTest();
  callOp.mockReset();
});
afterEach(cleanup);

describe("image box (B-703)", () => {
  it("reserves the box from the recorded size, asking once for every image on screen", async () => {
    callOp.mockResolvedValue({
      assets: [
        { id: "aaaaaaaaaaaaaa", width: 1200, height: 900 },
        { id: "bbbbbbbbbbbbbb", width: null, height: null },
      ],
    });
    const { container } = renderContent(
      "![a](assets/aaaaaaaaaaaaaa.png) ![b](../assets/bbbbbbbbbbbbbb.svg) ![c](https://example.com/x.png)",
    );
    const [a, b, c] = [...container.querySelectorAll("img.vr-image")] as HTMLImageElement[];
    await waitFor(() => expect(a?.getAttribute("width")).toBe("1200"));
    expect(a?.getAttribute("height")).toBe("900");
    expect(a?.getAttribute("style")).toContain("aspect-ratio: 1200 / 900");
    expect(a?.getAttribute("style")).toContain("width: min(100%, 1200px, "); // and a 70vh cap
    expect(b?.hasAttribute("width")).toBe(false);
    expect(b?.getAttribute("style")).toBeNull();
    expect(c?.hasAttribute("width")).toBe(false);
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(callOp).toHaveBeenCalledWith("asset.sizes", {
      ids: ["aaaaaaaaaaaaaa", "bbbbbbbbbbbbbb"],
    });
  });

  it("a known size is kept across renders and reloads without asking again", async () => {
    callOp.mockResolvedValue({ assets: [{ id: "cccccccccccccc", width: 40, height: 20 }] });
    const first = renderContent("![x](assets/cccccccccccccc.jpg)");
    await waitFor(() =>
      expect(first.container.querySelector("img")?.getAttribute("width")).toBe("40"),
    );
    cleanup();
    const again = renderContent("![x](assets/cccccccccccccc.jpg)");
    expect(again.container.querySelector("img")?.getAttribute("width")).toBe("40");
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nooklet.assetSizes.v1")).toContain("cccccccccccccc");
  });

  it("a failed request leaves the image as it was", async () => {
    callOp.mockRejectedValue(new Error("offline"));
    const { container } = renderContent("![x](assets/dddddddddddddd.png)");
    await waitFor(() => expect(callOp).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img")?.hasAttribute("width")).toBe(false);
    expect(container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  });
});
