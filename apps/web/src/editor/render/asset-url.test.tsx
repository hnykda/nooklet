// @vitest-environment jsdom
/**
 * B-737 / ADR 036: the client builds every asset URL with the asset's secret key, which it learns
 * from `asset.info` (faked at `callOp`) or from `asset.upload`'s answer, and keeps. While a key is
 * not known, the picture has no `src` at all (no broken-image flash), and gets one when it lands.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callOp = vi.fn();
vi.mock("../../data/api-client.js", () => ({
  callOp: (...a: unknown[]) => callOp(...a),
  describeError: (e: unknown) => String(e),
}));

const { rememberAsset, resetAssetInfoForTest } = await import("../../data/asset-info.js");
const { assetIdOf, assetUrl, resolveAssetUrl } = await import("./asset-url.js");
const { BlockContentView } = await import("./tokens.js");

function renderContent(content: string) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content }} />);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A deferred `asset.info` answer, so a test can look at the page before the key lands. */
function deferredAnswer() {
  let resolve!: (v: unknown) => void;
  callOp.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (v: unknown) => resolve(v);
}

beforeEach(() => {
  resetAssetInfoForTest();
  callOp.mockReset();
});
afterEach(cleanup);

describe("assetUrl with a known key", () => {
  it("puts the key in the URL; the block's own path, and anything not an asset, is untouched", () => {
    rememberAsset("aaaaaaaaaaaaaa", "fake-key-a", 10, 10);
    expect(assetUrl("assets/aaaaaaaaaaaaaa.png")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a");
    expect(assetUrl("../assets/aaaaaaaaaaaaaa.png")).toBe(
      "/assets/aaaaaaaaaaaaaa.png?k=fake-key-a",
    );
    expect(assetUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(assetUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(assetIdOf("assets/aaaaaaaaaaaaaa.png")).toBe("aaaaaaaaaaaaaa");
    expect(callOp).not.toHaveBeenCalled();
  });

  it("is kept across a reload (localStorage), so a picture seen before shows offline", () => {
    rememberAsset("aaaaaaaaaaaaaa", "fake-key-a", null, null);
    expect(localStorage.getItem("nooklet.assetInfo.v2")).toContain("fake-key-a");
    // A reload: the in-memory map is gone, the stored copy is not.
    const saved = localStorage.getItem("nooklet.assetInfo.v2");
    resetAssetInfoForTest();
    localStorage.setItem("nooklet.assetInfo.v2", saved as string);
    callOp.mockRejectedValue(new Error("offline"));
    expect(assetUrl("assets/aaaaaaaaaaaaaa.png")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a");
    expect(callOp).not.toHaveBeenCalled();
  });

  it("drops the sizes-only cache B-703 kept (it has no keys)", () => {
    localStorage.setItem("nooklet.assetSizes.v1", JSON.stringify({ x: [1, 1] }));
    resetAssetInfoForTest();
    rememberAsset("aaaaaaaaaaaaaa", "fake-key-a", null, null);
    expect(localStorage.getItem("nooklet.assetSizes.v1")).toBeNull();
  });
});

describe("a key not known yet", () => {
  it("renders no src, asks once for everything on screen, and fills the URL in when it lands", async () => {
    const answer = deferredAnswer();
    const { container } = renderContent(
      "![a](assets/aaaaaaaaaaaaaa.png) ![b](assets/bbbbbbbbbbbbbb.jpg) [doc](assets/cccccccccccccc.pdf)",
    );
    await tick();
    const [a, b] = [...container.querySelectorAll("img.vr-image")] as HTMLImageElement[];
    const link = container.querySelector("a.vr-link") as HTMLAnchorElement;
    // Nothing that would load and fail: no src, no href.
    expect(a?.hasAttribute("src")).toBe(false);
    expect(b?.hasAttribute("src")).toBe(false);
    expect(link.hasAttribute("href")).toBe(false);
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(callOp).toHaveBeenCalledWith("asset.info", {
      ids: ["aaaaaaaaaaaaaa", "bbbbbbbbbbbbbb", "cccccccccccccc"],
    });

    answer({
      assets: [
        { id: "aaaaaaaaaaaaaa", key: "fake-key-a", width: 800, height: 600 },
        { id: "bbbbbbbbbbbbbb", key: "fake-key-b", width: null, height: null },
        { id: "cccccccccccccc", key: "fake-key-c", width: null, height: null },
      ],
    });
    await waitFor(() => expect(a?.getAttribute("src")).toMatch(/\?k=fake-key-a&w=\d+$/));
    expect(b?.getAttribute("src")).toMatch(/\?k=fake-key-b&w=\d+$/);
    expect(link.getAttribute("href")).toBe("/assets/cccccccccccccc.pdf?k=fake-key-c");
    expect(a?.getAttribute("width")).toBe("800"); // the size came in the same answer
    expect(callOp).toHaveBeenCalledTimes(1);
  });

  it("an id the server does not know gets the bare URL, which fails as any dead link does", async () => {
    callOp.mockResolvedValue({ assets: [] });
    expect(assetUrl("assets/dddddddddddddd.png")).toBeUndefined();
    await waitFor(() =>
      expect(assetUrl("assets/dddddddddddddd.png")).toBe("/assets/dddddddddddddd.png"),
    );
  });

  it("a Logseq file name that is no asset id is not asked about (it would fail the whole batch)", () => {
    expect(assetUrl("assets/My Photo 2024.png")).toBe("/assets/My Photo 2024.png");
    expect(callOp).not.toHaveBeenCalled();
  });

  it("offline: asks again when the browser is back online", async () => {
    callOp.mockRejectedValueOnce(new Error("offline"));
    expect(assetUrl("assets/eeeeeeeeeeeeee.png")).toBeUndefined();
    await waitFor(() => expect(callOp).toHaveBeenCalledTimes(1));
    await tick();
    callOp.mockResolvedValueOnce({
      assets: [{ id: "eeeeeeeeeeeeee", key: "fake-key-e", width: null, height: null }],
    });
    window.dispatchEvent(new Event("online"));
    await waitFor(() =>
      expect(assetUrl("assets/eeeeeeeeeeeeee.png")).toBe("/assets/eeeeeeeeeeeeee.png?k=fake-key-e"),
    );
  });

  it("resolveAssetUrl waits for the key, for an action outside rendering", async () => {
    callOp.mockResolvedValue({
      assets: [{ id: "ffffffffffffff", key: "fake-key-f", width: null, height: null }],
    });
    await expect(resolveAssetUrl("assets/ffffffffffffff.pdf")).resolves.toBe(
      "/assets/ffffffffffffff.pdf?k=fake-key-f",
    );
    await expect(resolveAssetUrl("https://example.com/a")).resolves.toBe("https://example.com/a");
  });
});

describe("a rotated key (nooklet asset rotate-key)", () => {
  it("a picture that fails to load asks for its key again, once, and reloads with the new one", async () => {
    rememberAsset("aaaaaaaaaaaaaa", "old-fake-key", null, null);
    const { container } = renderContent("![a](assets/aaaaaaaaaaaaaa.png)");
    await tick();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("?k=old-fake-key");

    callOp.mockResolvedValue({
      assets: [{ id: "aaaaaaaaaaaaaa", key: "new-fake-key", width: null, height: null }],
    });
    fireEvent.error(img);
    await waitFor(() => expect(img.getAttribute("src")).toContain("?k=new-fake-key"));
    expect(callOp).toHaveBeenCalledTimes(1);

    // A second failure (the server really has lost the file, or no network) is not a loop.
    fireEvent.error(img);
    await tick();
    expect(callOp).toHaveBeenCalledTimes(1);
  });
});
