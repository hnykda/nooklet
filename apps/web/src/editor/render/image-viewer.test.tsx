// @vitest-environment jsdom
/**
 * B-736: a click on a rendered image opens the image viewer and does NOT enter the editor; a click
 * elsewhere in the block still does. And the viewer's actions take each host's own path to save.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callOp = vi.fn();
vi.mock("../../data/api-client.js", () => ({
  callOp: (...a: unknown[]) => callOp(...a),
  describeError: (e: unknown) => String(e),
}));
const shareFile = vi.fn();
vi.mock("../../platform/index.js", () => ({
  platform: { name: "web", share: { shareFile: (...a: unknown[]) => shareFile(...a) } },
}));

const { BlockRowView } = await import("../BlockRowView.js");
const { downloadImage, downloadName, copyImage } = await import("./image-actions.js");
const { DESKTOP_DOWNLOAD_EVENT } = await import("../../platform/desktop-shell.js");

const IMG = "assets/aaaaaaaaaaaaaa.png";

function renderRow(content: string, onEnterEdit = vi.fn()) {
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
  const r = render(() => (
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
      onEnterEdit={onEnterEdit}
      onToggleCollapse={() => {}}
      onZoomIn={() => {}}
      onToggleMarker={() => {}}
      onSelectClick={() => {}}
    />
  ));
  return { ...r, onEnterEdit };
}

beforeEach(() => {
  callOp.mockReset();
  callOp.mockResolvedValue({ assets: [] });
  shareFile.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as Window & { __NOOKLET_DESKTOP__?: unknown }).__NOOKLET_DESKTOP__;
});

describe("clicking an image (B-736)", () => {
  it("opens the viewer and does not enter edit mode", async () => {
    const { container, onEnterEdit } = renderRow(`before ![a shed](${IMG}) after`);
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    fireEvent.click(img);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Image: a shed");
    expect(onEnterEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeTruthy();
    // Clicking inside the viewer must not reach the row either (the portal bubbles to it).
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    expect(onEnterEdit).not.toHaveBeenCalled();
  });

  it("'Edit block' closes the viewer and edits, the caret after the image", async () => {
    const content = `![x](${IMG}) tail`;
    const { container, onEnterEdit } = renderRow(content);
    fireEvent.click(container.querySelector("img.vr-image") as HTMLImageElement);
    fireEvent.click(await screen.findByRole("button", { name: "Edit block" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onEnterEdit).toHaveBeenCalledWith(content.indexOf(" tail"));
  });

  it("a click on the text beside the image still edits", () => {
    const { container, onEnterEdit } = renderRow(`before ![a shed](${IMG}) after`);
    fireEvent.click(container.querySelector(".vr-block-view") as HTMLElement);
    expect(onEnterEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a modified click is the row's (Cmd/Ctrl select), not the viewer's", () => {
    const { container, onEnterEdit } = renderRow(`![x](${IMG})`);
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    fireEvent.click(img, { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onEnterEdit).not.toHaveBeenCalled(); // went to onSelectClick, as before
    fireEvent.click(img, { altKey: false });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("opens from the keyboard and closes on Escape and on the backdrop, editing nothing", async () => {
    const { container, onEnterEdit } = renderRow(`![x](${IMG})`);
    const img = container.querySelector("img.vr-image") as HTMLImageElement;
    expect(img.getAttribute("role")).toBe("button");
    expect(img.tabIndex).toBe(0);
    fireEvent.keyDown(img, { key: "Enter" });
    await screen.findByRole("dialog");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(img);
    const backdrop = (await screen.findByRole("dialog")).parentElement as HTMLElement;
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onEnterEdit).not.toHaveBeenCalled();
  });
});

describe("image actions (B-736)", () => {
  it("names the file after the alt text, else the asset id, keeping the extension", () => {
    expect(downloadName(IMG, "a shed")).toBe("a shed.png");
    expect(downloadName("../assets/bbbbbbbbbbbbbb.jpeg", "")).toBe("bbbbbbbbbbbbbb.jpeg");
    expect(downloadName("https://example.com/p/photo.webp?x=1", "")).toBe("photo.webp");
    expect(downloadName("https://example.com/p/raw", "a/b:c", "image/gif")).toBe("a_b_c.gif");
  });

  it("browser: downloads a blob through <a download>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } })),
    );
    const createObjectURL = vi.fn(() => "blob:fake");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const r = await downloadImage("/assets/aaaaaaaaaaaaaa.png", IMG, "a shed", "web");
    expect(r).toEqual({ ok: true, message: "Downloaded a shed.png." });
    expect(clicked[0]?.download).toBe("a shed.png");
    expect(clicked[0]?.getAttribute("href")).toBe("blob:fake");
  });

  it("desktop: hands the shell the asset's own URL and reports where it saved it", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // What main.rs's on_download does once WKWebView's download finishes.
      window.dispatchEvent(
        new CustomEvent(DESKTOP_DOWNLOAD_EVENT, {
          detail: { ok: true, url: this.href, name: "a shed (1).png" },
        }),
      );
    });
    const r = await downloadImage("/assets/aaaaaaaaaaaaaa.png", IMG, "a shed", "desktop");
    expect(r).toEqual({ ok: true, message: "Saved to Downloads as a shed (1).png." });
  });

  it("phone: goes to the share sheet with the bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } })),
    );
    shareFile.mockResolvedValue(true);
    const r = await downloadImage("/assets/aaaaaaaaaaaaaa.png", IMG, "", "phone");
    expect(r.ok).toBe(true);
    expect(shareFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "aaaaaaaaaaaaaa.png", blob: expect.any(Blob) }),
    );
  });

  it("copy: says so when the clipboard cannot take images", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const r = await copyImage("/assets/aaaaaaaaaaaaaa.png");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/isn't supported/);
  });

  it("copy: writes a PNG ClipboardItem", async () => {
    const write = vi.fn(async () => {});
    class FakeItem {
      constructor(public items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } })),
    );
    const r = await copyImage("/assets/aaaaaaaaaaaaaa.png");
    expect(r).toEqual({ ok: true, message: "Image copied." });
    const item = (write.mock.calls[0] as unknown as [FakeItem[]])[0][0] as FakeItem;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect((await item.items["image/png"])?.type).toBe("image/png");
  });
});
