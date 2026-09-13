// @vitest-environment jsdom
/**
 * `{{embed}}` rendered through the real contract (`BlockContentView` → lazy `EmbedView`), with the
 * data read mocked: what an embed shows, where its clicks go, and that it stops — at the depth
 * limit and at a cycle. The read itself is `../../data/embeds.test.ts`; the whole path against a
 * real server is `e2e/tests/embeds.spec.ts`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedData, EmbedTarget } from "../../data/embeds.js";
import type { BlockTreeNode } from "../../data/types.js";

const fake = vi.hoisted(() => ({
  set: undefined as unknown as (key: string, data: EmbedData) => void,
  reads: [] as string[],
}));

vi.mock("../../data/embeds.js", async () => {
  const { createSignal } = await import("solid-js");
  const [store, setStore] = createSignal<ReadonlyMap<string, EmbedData>>(new Map());
  fake.set = (key, data) =>
    setStore((prev) => {
      const next = new Map(prev);
      next.set(key, data);
      return next;
    });
  const keyOf = (t: EmbedTarget): string =>
    t.kind === "page" ? `page:${t.name}` : `block:${t.id}`;
  return {
    useEmbed: (target: () => EmbedTarget | undefined) => {
      const t = target();
      if (t) fake.reads.push(keyOf(t));
      return {
        get latest() {
          const now = target();
          return now ? store().get(keyOf(now)) : undefined;
        },
      };
    },
  };
});

// Runs the mock factory now: `tokens.tsx` only reaches the module through a lazy import, and the
// tests seed `fake.set` before anything has rendered.
import "../../data/embeds.js";
import { BlockContentView, type RenderCtx } from "./tokens.js";

const PAGE = {
  id: "P",
  graphId: "default",
  name: "Shopping",
  key: "shopping",
  journalDay: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  nameHlc: "h",
  deletedHlc: null,
};

function node(
  id: string,
  content: string,
  children: BlockTreeNode[] = [],
  extra: Partial<BlockTreeNode> = {},
): BlockTreeNode {
  return {
    id,
    content,
    children,
    collapsed: false,
    marker: null,
    priority: null,
    pageId: "P",
    parentId: null,
    ...extra,
  } as BlockTreeNode;
}

function renderContent(content: string, ctx: Partial<RenderCtx> = {}) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content, ...ctx }} />);
}

/** For every wait on a first render: see `rows`. */
const SOON = { timeout: 5000 };

async function rows(container: HTMLElement, min = 1): Promise<HTMLElement[]> {
  // 5 s, not waitFor's 1 s: the first render waits on the lazy chunk's dynamic import, which on a
  // machine shared with a dozen builds has taken longer than a second (one full-suite run failed).
  await waitFor(() => {
    expect(container.querySelectorAll(".vr-embed-item").length).toBeGreaterThanOrEqual(min);
  }, SOON);
  return [...container.querySelectorAll<HTMLElement>(".vr-embed-item")];
}

beforeEach(() => {
  fake.reads.length = 0;
});
afterEach(cleanup);

describe("a block embed", () => {
  beforeEach(() => {
    fake.set("block:list", {
      status: "block",
      page: PAGE,
      node: node(
        "list",
        "todo",
        [
          node("milk", "buy **milk**", [], { marker: "TODO" }),
          node("folded", "folded away", [node("hidden", "under a fold")], { collapsed: true }),
        ],
        { collapsed: true },
      ),
    });
  });

  it("renders the block and its children read-only, root open even when stored collapsed", async () => {
    const { container } = renderContent("{{embed ((list))}}");
    const items = await rows(container, 3);
    expect(items.map((li) => li.dataset.embedBlockId)).toEqual(["list", "milk", "folded"]);
    expect(container.querySelector(".vr-embed.vr-embed-block")).not.toBeNull();
    expect(container.querySelector(".vr-embed-source")?.textContent).toBe("Shopping");
    expect(items[1]?.querySelector("strong")?.textContent).toBe("milk");
    expect(items[1]?.querySelector(".vr-marker-TODO")).not.toBeNull();
    // A collapsed descendant stays folded (its child is not a row), and says so.
    expect(container.textContent).not.toContain("under a fold");
    expect(items[2]?.querySelector(".vr-embed-toggle")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    // Embedded rows must not look like outliner rows to `[data-block-id]` lookups (B-211's trap).
    expect(container.querySelector("[data-block-id]")).toBeNull();
    // Nothing editable inside.
    expect(container.querySelector("[contenteditable], textarea")).toBeNull();
  });

  it("clicking a row navigates to that block and does not reach the host block", async () => {
    const onNavigate = vi.fn();
    const onHostClick = vi.fn();
    const content = "{{embed ((list))}}";
    const { container } = render(() => (
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the host `.vr-block-view`, whose click enters edit mode.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test double.
      <div onClick={onHostClick}>
        <BlockContentView
          content={classifyBlockContent(content)}
          ctx={{ source: content, onNavigate }}
        />
      </div>
    ));
    const items = await rows(container, 3);
    fireEvent.click(items[1]?.querySelector(".vr-embed-content") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "block", id: "milk" });
    expect(onHostClick).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector(".vr-embed-source") as HTMLElement);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "page", name: "Shopping" });
    expect(onHostClick).not.toHaveBeenCalled();

    // The frame itself is the host's: that is how a block holding only an embed gets edited.
    fireEvent.click(container.querySelector(".vr-embed-head") as HTMLElement);
    expect(onHostClick).toHaveBeenCalledTimes(1);
  });

  it("a web link in a row keeps its own default: no navigation to the block, no host edit (B-216)", async () => {
    fake.set("block:links", {
      status: "block",
      page: PAGE,
      node: node("links", "see https://example.com/b216"),
    });
    const onNavigate = vi.fn();
    const onHostClick = vi.fn();
    const content = "{{embed ((links))}}";
    const { container } = render(() => (
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the host `.vr-block-view`, whose click enters edit mode.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test double.
      <div onClick={onHostClick}>
        <BlockContentView
          content={classifyBlockContent(content)}
          ctx={{ source: content, onNavigate }}
        />
      </div>
    ));
    await rows(container, 1);
    const link = container.querySelector(".vr-embed-item a.vr-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/b216");
    // `fireEvent` returns false when a handler called preventDefault — i.e. the tab would not open.
    expect(fireEvent.click(link)).toBe(true);
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onHostClick).not.toHaveBeenCalled();
  });

  it("Shift+click on a row shelves the block instead of navigating", async () => {
    const onNavigate = vi.fn();
    const onShelfOpen = vi.fn();
    const { container } = renderContent("{{embed ((list))}}", { onNavigate, onShelfOpen });
    const items = await rows(container, 3);
    fireEvent.click(items[1]?.querySelector(".vr-embed-row") as HTMLElement, { shiftKey: true });
    // With the block's own page: the shelf is opened from the HOST page's tree (B-215).
    expect(onShelfOpen).toHaveBeenCalledWith({ kind: "block", id: "milk", pageId: "P" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("the toggle unfolds a collapsed child in the embed only, without navigating", async () => {
    const onNavigate = vi.fn();
    const { container } = renderContent("{{embed ((list))}}", { onNavigate });
    const items = await rows(container, 3);
    fireEvent.click(items[2]?.querySelector(".vr-embed-toggle") as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain("under a fold"), SOON);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("a re-read with the same text keeps the rendered rows (keyed by id, not by node object)", async () => {
    const { container } = renderContent("{{embed ((list))}}");
    const before = (await rows(container, 3))[1]?.querySelector("strong");
    fake.set("block:list", {
      status: "block",
      page: PAGE,
      node: node(
        "list",
        "todo",
        [
          node("milk", "buy **milk**", [], { marker: "TODO" }),
          node("folded", "folded away", [node("hidden", "under a fold")], { collapsed: true }),
          node("eggs", "eggs"),
        ],
        { collapsed: true },
      ),
    });
    await rows(container, 4);
    expect(container.querySelectorAll(".vr-embed-item")[1]?.querySelector("strong")).toBe(before);
  });
});

describe("a page embed", () => {
  it("renders the page's top-level blocks under the page's name", async () => {
    fake.set("page:Shopping", {
      status: "page",
      page: PAGE,
      blocks: [node("a", "first"), node("b", "second", [node("b1", "nested")])],
    });
    const { container } = renderContent("{{embed [[Shopping]]}}");
    const items = await rows(container, 3);
    expect(items.map((li) => li.dataset.embedBlockId)).toEqual(["a", "b", "b1"]);
    expect(items[2]?.style.getPropertyValue("--depth")).toBe("1");
    expect(container.querySelector(".vr-embed.vr-embed-page .vr-embed-source")?.textContent).toBe(
      "Shopping",
    );
  });

  it("numbers list:: number blocks as the page does, each group of children on its own (B-551)", async () => {
    const num: Partial<BlockTreeNode> = { properties: { list: "number" } };
    fake.set("page:Steps", {
      status: "page",
      page: { ...PAGE, name: "Steps" },
      blocks: [
        node("s1", "one", [], num),
        node("s2", "two", [node("c1", "a", [], num), node("c2", "b", [], num)], num),
        node("s3", "plain"),
      ],
      rootOrdinals: new Map([
        ["s1", 1],
        ["s2", 2],
      ]),
    });
    const { container } = renderContent("{{embed [[Steps]]}}");
    const items = await rows(container, 5);
    expect(items.map((li) => li.querySelector(".vr-list-number")?.textContent ?? "")).toEqual([
      "1.",
      "2.",
      "1.",
      "2.",
      "",
    ]);
  });

  it("an empty page says so", async () => {
    fake.set("page:Empty", { status: "page", page: { ...PAGE, name: "Empty" }, blocks: [] });
    const { container } = renderContent("{{embed [[Empty]]}}");
    await waitFor(() => expect(container.textContent).toContain("Empty page."), SOON);
  });
});

describe("states in words", () => {
  it("a missing block and a missing page", async () => {
    fake.set("block:gone", { status: "missing" });
    fake.set("page:Nowhere", { status: "missing" });
    const { container } = renderContent("{{embed ((gone))}} and {{embed [[Nowhere]]}}");
    await waitFor(
      () => expect(container.querySelectorAll(".vr-embed-missing")).toHaveLength(2),
      SOON,
    );
    expect(container.textContent).toContain("Embedded block not found: ((gone))");
    expect(container.textContent).toContain("Embedded page doesn't exist yet: [[Nowhere]]");
  });

  it("a failed read", async () => {
    fake.set("block:broken", { status: "failed", message: "worker gone" });
    const { container } = renderContent("{{embed ((broken))}}");
    await waitFor(() => expect(container.querySelector(".vr-embed-failed")).not.toBeNull(), SOON);
    expect(container.textContent).toContain("worker gone");
  });
});

describe("termination", () => {
  it("a block embedding itself shows a cycle notice, not itself", async () => {
    fake.set("block:self", {
      status: "block",
      page: PAGE,
      node: node("self", "{{embed ((self))}}"),
    });
    // What `BlockRowView` passes for the row `self`.
    const { container } = renderContent("{{embed ((self))}}", { embedPath: ["self"] });
    await waitFor(() => expect(container.querySelector(".vr-embed-cycle")).not.toBeNull(), SOON);
    expect(container.querySelector(".vr-embed-item")).toBeNull();
  });

  it("a page embedding itself shows a cycle notice (the host row is one of its blocks)", async () => {
    fake.set("page:Loop", {
      status: "page",
      page: { ...PAGE, name: "Loop" },
      blocks: [node("intro", "intro"), node("host", "{{embed [[Loop]]}}")],
    });
    const { container } = renderContent("{{embed [[Loop]]}}", { embedPath: ["host"] });
    await waitFor(() => expect(container.querySelector(".vr-embed-cycle")).not.toBeNull(), SOON);
    expect(container.querySelector(".vr-embed-item")).toBeNull();
  });

  it("two blocks embedding each other stop one level down", async () => {
    fake.set("block:a", { status: "block", page: PAGE, node: node("a", "A {{embed ((b))}}") });
    fake.set("block:b", { status: "block", page: PAGE, node: node("b", "B {{embed ((a))}}") });
    const { container } = renderContent("A {{embed ((b))}}", { embedPath: ["a"] });
    // Row `a` shows b; b's own embed of a would render a again → notice.
    await waitFor(() => expect(container.querySelector(".vr-embed-cycle")).not.toBeNull(), SOON);
    expect(
      [...container.querySelectorAll<HTMLElement>(".vr-embed-item")].map(
        (li) => li.dataset.embedBlockId,
      ),
    ).toEqual(["b"]);
  });

  it("with no known host, nesting stops at the depth limit with a link", async () => {
    fake.set("block:a", { status: "block", page: PAGE, node: node("a", "A {{embed ((b))}}") });
    fake.set("block:b", { status: "block", page: PAGE, node: node("b", "B {{embed ((c))}}") });
    fake.set("block:c", { status: "block", page: PAGE, node: node("c", "C {{embed ((d))}}") });
    const onNavigate = vi.fn();
    const { container } = renderContent("{{embed ((a))}}", { onNavigate });
    await waitFor(() => expect(container.querySelector(".vr-embed-limit")).not.toBeNull(), SOON);
    expect(
      [...container.querySelectorAll<HTMLElement>(".vr-embed-item")].map(
        (li) => li.dataset.embedBlockId,
      ),
    ).toEqual(["a", "b"]);
    expect(fake.reads).not.toContain("block:c");
    fireEvent.click(container.querySelector(".vr-embed-limit .vr-embed-target") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "block", id: "c" });
  });
});

describe("the row cap", () => {
  it("renders at most EMBED_ROW_CAP rows and counts the rest", async () => {
    const many = Array.from({ length: 260 }, (_, i) => node(`n${i}`, `row ${i}`));
    fake.set("page:Long", { status: "page", page: { ...PAGE, name: "Long" }, blocks: many });
    const onNavigate = vi.fn();
    const { container } = renderContent("{{embed [[Long]]}}", { onNavigate });
    await rows(container, 250);
    expect(container.querySelectorAll(".vr-embed-item")).toHaveLength(250);
    const more = container.querySelector(".vr-embed-more") as HTMLElement;
    expect(more.textContent).toBe("10 more blocks");
    fireEvent.click(more);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Long" });
  });
});
