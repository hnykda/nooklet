// @vitest-environment jsdom
/**
 * B-789: an image's size and alignment from Logseq's `{:width …}` map (ADR 034), its ⋯ menu, and
 * what each writes back. The drag itself needs real layout and is driven in
 * `e2e/tests/image-resize.spec.ts`.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../data/api-client.js", () => ({
  callOp: vi.fn(() => new Promise(() => {})),
  describeError: (e: unknown) => String(e),
}));
vi.mock("../../platform/index.js", () => ({
  platform: { name: "web", share: { shareFile: vi.fn() } },
}));

const { BlockRowView } = await import("../BlockRowView.js");
const { revealTarget, revealLabel } = await import("./image-actions.js");

const IMG = "assets/aaaaaaaaaaaaaa.png";

function renderRow(content: string, opts: { readOnly?: boolean } = {}) {
  const onEnterEdit = vi.fn();
  const onRewrite = vi.fn();
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
      readOnly={opts.readOnly}
      surfaceHost={() => {}}
      onEnterEdit={onEnterEdit}
      onToggleCollapse={() => {}}
      onZoomIn={() => {}}
      onToggleMarker={() => {}}
      onRewrite={onRewrite}
      onSelectClick={() => {}}
    />
  ));
  return { ...r, onEnterEdit, onRewrite };
}

afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noExplicitAny: removing the test's own stub.
  delete (window as any).matchMedia;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the size map renders as a size (ADR 034)", () => {
  it("width and alignment go on the box; the map is never shown as text", () => {
    const { container } = renderRow(
      `see ![shed](${IMG}){:height 236, :width 320, :align "center"}`,
    );
    const box = container.querySelector(".vr-image-box") as HTMLElement;
    expect(box.getAttribute("style")).toContain("width: min(100%, 320px)");
    expect(box.classList.contains("vr-image-center")).toBe(true);
    expect(box.classList.contains("vr-image-chosen")).toBe(true);
    expect(container.textContent).not.toContain("{:");
    expect(container.textContent).not.toContain("236");
  });

  it("right alignment puts the handle on the left edge, the one that moves", () => {
    const { container } = renderRow(`![a](${IMG}){:align "right"}`);
    expect(container.querySelector(".vr-image-right")).not.toBeNull();
    expect(container.querySelector(".vr-image-handle-left")).not.toBeNull();
  });
});

describe("the ⋯ menu", () => {
  it("opens without entering the editor; alignment and original size rewrite the block", async () => {
    const content = `before ![a](${IMG}){:width 200} after`;
    const { onEnterEdit, onRewrite } = renderRow(content);
    fireEvent.click(screen.getByRole("button", { name: "Image actions" }));
    await flush();
    expect(onEnterEdit).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Image actions" });
    expect(menu.textContent).toContain("Copy image");
    expect(menu.textContent).toContain("Download");
    // A browser has no Finder to show anything in.
    expect(menu.textContent).not.toContain("Finder");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Align right/ }));
    expect(onRewrite).toHaveBeenLastCalledWith(
      `before ![a](${IMG}){:width 200, :align "right"} after`,
    );
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Image actions" }));
    await flush();
    fireEvent.click(screen.getByRole("menuitem", { name: /Original size/ }));
    expect(onRewrite).toHaveBeenLastCalledWith(`before ![a](${IMG}) after`);
    expect(onEnterEdit).not.toHaveBeenCalled();
  });

  it("Escape closes it and gives focus back to ⋯", async () => {
    renderRow(`![a](${IMG})`);
    const trigger = screen.getByRole("button", { name: "Image actions" });
    fireEvent.click(trigger);
    await flush();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("no Original size without a chosen size", async () => {
    renderRow(`![a](${IMG})`);
    fireEvent.click(screen.getByRole("button", { name: "Image actions" }));
    await flush();
    expect(screen.queryByRole("menuitem", { name: /Original size/ })).toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: /Align left/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("a locked page: Copy and Download, but nothing that writes, and no handle", async () => {
    const { container, onRewrite } = renderRow(`![a](${IMG}){:width 200}`, { readOnly: true });
    expect(container.querySelector(".vr-image-handle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Image actions" }));
    await flush();
    expect(screen.getByRole("menu").textContent).toContain("Download");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Original size/ })).toBeNull();
    expect(onRewrite).not.toHaveBeenCalled();
  });
});

describe("touch (ADR 034)", () => {
  it("a phone gets neither the handle nor ⋯ — the tap opens the viewer", () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes("coarse"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const { container } = renderRow(`![a](${IMG}){:width 200}`);
    expect(container.querySelector(".vr-image-handle")).toBeNull();
    expect(container.querySelector(".vr-image-more")).toBeNull();
    // Still sized.
    expect(container.querySelector(".vr-image-box")?.getAttribute("style")).toContain("200px");
  });
});

describe("Show in Finder (desktop, This Mac only)", () => {
  const graphs = [
    {
      key: "mac:garden",
      place: "mac" as const,
      id: "garden",
      label: "Garden",
      address: "http://127.0.0.1:6100/g/garden",
    },
    {
      key: "server:s1",
      place: "server" as const,
      id: "s1",
      label: "Work",
      address: "https://notes.example.com/g/work",
    },
  ];
  const shell = {
    platform: "macos",
    port: 6100,
    downloads: true,
    reveal: true,
    deleteMac: false,
    listServerGraphs: false,
    key: "k",
    graphs,
    graphToken: null,
  };
  const at = (href: string) => new URL(href) as unknown as Location;

  it("offers it for an uploaded picture on a graph on This Mac", () => {
    expect(revealTarget(IMG, shell, at("http://127.0.0.1:6100/g/garden/page/Shed"))).toEqual({
      shell,
      graph: "mac:garden",
      asset: "aaaaaaaaaaaaaa",
    });
    expect(revealLabel(shell)).toBe("Show in Finder");
  });

  it("not on a server's graph, not for an external picture, not from an older shell", () => {
    expect(revealTarget(IMG, shell, at("https://notes.example.com/g/work/page/Shed"))).toBeNull();
    expect(
      revealTarget("https://example.com/x.png", shell, at("http://127.0.0.1:6100/g/garden")),
    ).toBeNull();
    expect(
      revealTarget(IMG, { ...shell, reveal: false }, at("http://127.0.0.1:6100/g/garden")),
    ).toBeNull();
    expect(revealTarget(IMG, null, at("http://127.0.0.1:6100/g/garden"))).toBeNull();
  });
});
