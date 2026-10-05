// @vitest-environment jsdom
/**
 * B-703: an image whose asset size is known gets its box before it loads; one whose size is not
 * (an external URL, an older server) renders as before. `asset.info` (B-737: sizes and URL keys
 * in one answer) is faked at `callOp`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callOp = vi.fn();
vi.mock("../../data/api-client.js", () => ({ callOp: (...a: unknown[]) => callOp(...a) }));

const { resetAssetInfoForTest } = await import("../../data/asset-info.js");
const { BlockContentView } = await import("./tokens.js");

function renderContent(content: string) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content }} />);
}

beforeEach(() => {
  resetAssetInfoForTest();
  callOp.mockReset();
});
afterEach(cleanup);

describe("image box (B-703)", () => {
  it("reserves the box from the recorded size, asking once for every image on screen", async () => {
    callOp.mockResolvedValue({
      assets: [
        { id: "aaaaaaaaaaaaaa", key: "fake-key-a", width: 1200, height: 900 },
        { id: "bbbbbbbbbbbbbb", key: "fake-key-b", width: null, height: null },
      ],
    });
    const { container } = renderContent(
      "![a](assets/aaaaaaaaaaaaaa.png) ![b](../assets/bbbbbbbbbbbbbb.svg) ![c](https://example.com/x.png)",
    );
    const [a, b, c] = [...container.querySelectorAll("img.vr-image")] as HTMLImageElement[];
    await waitFor(() => expect(a?.getAttribute("width")).toBe("1200"));
    expect(a?.getAttribute("height")).toBe("900");
    expect(a?.getAttribute("style")).toContain("aspect-ratio: 1200 / 900");
    // B-789: the width is on the box around the picture, which fills it.
    const boxA = a?.closest(".vr-image-box");
    expect(boxA?.getAttribute("style")).toContain("width: min(100%, 1200px, "); // and a 70vh cap
    expect(boxA?.classList.contains("vr-image-sized")).toBe(true);
    expect(b?.hasAttribute("width")).toBe(false);
    expect(b?.getAttribute("style")).toBeNull();
    expect(b?.closest(".vr-image-box")?.getAttribute("style")).toBeNull();
    expect(c?.hasAttribute("width")).toBe(false);
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(callOp).toHaveBeenCalledWith("asset.info", {
      ids: ["aaaaaaaaaaaaaa", "bbbbbbbbbbbbbb"],
    });
  });

  it("a known size is kept across renders and reloads without asking again", async () => {
    callOp.mockResolvedValue({
      assets: [{ id: "cccccccccccccc", key: "fake-key-c", width: 40, height: 20 }],
    });
    const first = renderContent("![x](assets/cccccccccccccc.jpg)");
    await waitFor(() =>
      expect(first.container.querySelector("img")?.getAttribute("width")).toBe("40"),
    );
    cleanup();
    const again = renderContent("![x](assets/cccccccccccccc.jpg)");
    expect(again.container.querySelector("img")?.getAttribute("width")).toBe("40");
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nooklet.assetInfo.v2")).toContain("cccccccccccccc");
  });

  it("a failed request leaves the image as it was", async () => {
    callOp.mockRejectedValue(new Error("offline"));
    const { container } = renderContent("![x](assets/dddddddddddddd.png)");
    await waitFor(() => expect(callOp).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img")?.hasAttribute("width")).toBe(false);
    expect(container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  });
});
