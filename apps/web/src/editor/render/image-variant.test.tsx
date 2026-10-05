// @vitest-environment jsdom
/**
 * B-738 / ADR 035: a picture in a note asks for the resized copy as wide as it is drawn, in device
 * pixels — never the 3-4 MB original — while the viewer keeps the original.
 */
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../data/api-client.js", () => ({
  callOp: vi.fn(() => new Promise(() => {})),
  describeError: (e: unknown) => String(e),
}));
vi.mock("../../platform/index.js", () => ({
  platform: { name: "web", share: { shareFile: vi.fn() } },
}));

const { BlockRowView } = await import("../BlockRowView.js");
const { rememberAsset, resetAssetInfoForTest } = await import("../../data/asset-info.js");
const { displayCssWidth, variantSrc, variantWidthFor } = await import("./image-variant.js");

describe("variantWidthFor: the smallest variant with a device pixel per pixel shown", () => {
  it.each([
    // css width, devicePixelRatio, expected
    [200, 1, 480],
    [480, 1, 480],
    [481, 1, 960],
    [700, 1, 960],
    [700, 2, 1600],
    [390, 3, 1600], // a phone's full width at 3x
    [450, 2, 960],
    [1000, 1, 1600],
    [1000, 2, 1600], // 2000 device px: within 25 % of 1600
    [1001, 2, undefined], // beyond: the original
    [1300, 3, undefined],
  ])("%d css px at %dx → %s", (css, dpr, expected) => {
    expect(variantWidthFor(css, dpr)).toBe(expected);
  });

  it("treats a missing or nonsense devicePixelRatio as 1, and a zero width as tiny", () => {
    expect(variantWidthFor(700, Number.NaN)).toBe(960);
    expect(variantWidthFor(700, 0)).toBe(960);
    expect(variantWidthFor(0, 2)).toBe(480);
  });
});

describe("displayCssWidth: the width the box draws the picture at", () => {
  it("a width the person chose (B-789), never wider than the column", () => {
    expect(displayCssWidth({ column: 700, chosen: 320, viewportHeight: 900 })).toBe(320);
    expect(displayCssWidth({ column: 700, chosen: 2000, viewportHeight: 900 })).toBe(700);
  });

  it("an unchosen picture: its own width, the column, or 70vh tall, whichever is least", () => {
    const natural = { width: 4032, height: 3024 };
    expect(displayCssWidth({ column: 700, natural, viewportHeight: 2000 })).toBe(700);
    // A portrait phone photo in an 800-px-tall window: 560 px tall, so 420 wide.
    const portrait = { width: 3024, height: 4032 };
    expect(displayCssWidth({ column: 700, natural: portrait, viewportHeight: 800 })).toBe(420);
    expect(
      displayCssWidth({ column: 700, natural: { width: 300, height: 200 }, viewportHeight: 800 }),
    ).toBe(300);
  });

  it("size unknown: the column", () => {
    expect(displayCssWidth({ column: 640, viewportHeight: 800 })).toBe(640);
  });
});

describe("variantSrc", () => {
  it("adds w after the asset's key (B-737), to the graph's own assets only", () => {
    resetAssetInfoForTest();
    rememberAsset("abc", "fake-key", null, null);
    expect(variantSrc("assets/abc.png", 960)).toBe("/assets/abc.png?k=fake-key&w=960");
    expect(variantSrc("../assets/abc.jpg", 480)).toBe("/assets/abc.jpg?k=fake-key&w=480");
    expect(variantSrc("assets/abc.png", undefined)).toBe("/assets/abc.png?k=fake-key");
    expect(variantSrc("https://example.com/x.png", 960)).toBe("https://example.com/x.png");
  });

  it("nothing while the key is not known yet", () => {
    resetAssetInfoForTest();
    expect(variantSrc("assets/notyetknown.png", 960)).toBeUndefined();
  });
});

// ---- the rendered <img> -----------------------------------------------------------------------

const IMG = "assets/aaaaaaaaaaaaaa.png";

function renderRow(content: string) {
  const block = {
    id: "b1",
    parentId: null,
    order: "a0",
    content,
    marker: null,
    priority: null,
    collapsed: false,
    scheduled: null,
    deadline: null,
    repeat: null,
    doneAt: null,
    properties: {},
  };
  return render(() => (
    <BlockRowView
      id="b1"
      depth={0}
      hasChildren={false}
      collapsed={false}
      childCount={0}
      block={block as never}
      numbering={undefined}
      editing={false}
      selected={false}
      surfaceHost={() => {}}
      onEnterEdit={() => {}}
      onToggleCollapse={() => {}}
      onZoomIn={() => {}}
      onToggleMarker={() => {}}
      onSelectClick={() => {}}
    />
  ));
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const saved = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };

function screenOf(width: number, height: number, dpr: number): void {
  // jsdom lays nothing out, so the column falls back to the window's width (`measureColumn`).
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
}

beforeEach(() => {
  screenOf(700, 900, 1);
  resetAssetInfoForTest();
  rememberAsset("aaaaaaaaaaaaaa", "fake-key-a", null, null);
});
afterEach(() => {
  cleanup();
  screenOf(saved.w, saved.h, saved.dpr);
});

describe("the <img> in a note", () => {
  it("asks for the variant as wide as the column at this devicePixelRatio, lazily and async", async () => {
    screenOf(700, 900, 2);
    const { container } = renderRow(`![shed](${IMG})`);
    await flush();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a&w=1600");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("has no src at all until the column is measured, so no guessed width is ever fetched", () => {
    const { container } = renderRow(`![shed](${IMG})`);
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);
  });

  it("a chosen {:width N} (B-789) asks for the copy that width needs", async () => {
    screenOf(1200, 900, 2);
    const { container } = renderRow(`![shed](${IMG}){:width 200}`);
    await flush();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a&w=480");
  });

  it("more device pixels than the largest variant has: the original", async () => {
    screenOf(1300, 900, 3);
    const { container } = renderRow(`![shed](${IMG})`);
    await flush();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a");
  });

  it("an image from the web is left exactly as written", async () => {
    const { container } = renderRow("![x](https://example.com/x.png)");
    await flush();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/x.png");
  });

  it("the viewer shows the original, not the variant", async () => {
    const { container } = renderRow(`![shed](${IMG})`);
    await flush();
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("&w=");
    fireEvent.click(img);
    const big = document.querySelector("img.image-viewer-img") as HTMLImageElement;
    expect(big.getAttribute("src")).toBe("/assets/aaaaaaaaaaaaaa.png?k=fake-key-a");
  });
});
