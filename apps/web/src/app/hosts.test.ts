/**
 * `createNavigationHost#followLink` (Alt+Enter, `nav.followLink`), and `createStore`'s
 * block-property writes going through the editor's undo history (B-142).
 *
 * - An asset path opens from the API origin's `/assets/` route, like the rendered `<a>` does —
 *   raw, `window.open` resolved `assets/x.pdf` against the current `/page/...` URL and the SPA
 *   fallback answered with index.html (B-137, the keyboard path of B-51).
 * - A `((block ref))` zooms to the block on its page. Its page is looked up by BLOCK id; the host's
 *   `pageNameForId` takes a PAGE id (B-82), so asking it about a block found nothing (B-139).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/bootstrap.js", () => ({ apiBaseUrl: () => "http://api.test:6100" }));
vi.mock("../data/store.js", () => ({
  resolveBlockPageName: async (id: string) =>
    id === "blk00000000001" ? "Projects/Aurora" : undefined,
}));
vi.mock("../db/client.js", () => ({}));
vi.mock("../live/flash-bus.js", () => ({}));
vi.mock("../live/resolve-page-ref.js", () => ({}));

const open = vi.fn();
vi.stubGlobal("window", { open });

import type { Op } from "@nooklet/core";
import type { OpBatch } from "../commands/hosts/editor-host.js";
import { rememberAsset } from "../data/asset-info.js";
import { editingEndRequest } from "../editor/focus-request.js";
import { createNavigationHost, createStore } from "./hosts.js";

const navigate = vi.fn();

function host() {
  // Like the real wiring (`store.ts#resolvePageName`): knows page ids, not block ids.
  return createNavigationHost({
    navigate,
    pageNameForId: async (id) => (id === "pg000000000001" ? "Projects/Aurora" : undefined),
  });
}

describe("nav.followLink for URL links", () => {
  beforeEach(() => {
    open.mockReset();
    rememberAsset("spec", "fake-key", null, null); // as asset.info would have answered (B-737)
  });

  it.each([
    ["assets/spec.pdf"],
    ["../assets/spec.pdf"],
    ["./assets/spec.pdf"],
    ["/assets/spec.pdf"],
  ])("opens the asset %s from the API origin", (href) => {
    host().followLink({ type: "url", href });
    expect(open).toHaveBeenCalledWith(
      "http://api.test:6100/assets/spec.pdf?k=fake-key",
      "_blank",
      "noopener",
    );
  });

  it("opens an ordinary web link as written", () => {
    host().followLink({ type: "url", href: "https://example.com/a?b=c#d" });
    expect(open).toHaveBeenCalledWith("https://example.com/a?b=c#d", "_blank", "noopener");
  });
});

describe("nav.followLink for block refs", () => {
  beforeEach(() => navigate.mockReset());

  it("zooms to the referenced block on its page", async () => {
    host().followLink({ type: "block", id: "blk00000000001" });
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/page/Projects/Aurora?block=blk00000000001"),
    );
  });

  it("goes nowhere for a block the replica does not have", async () => {
    host().followLink({ type: "block", id: "blk-missing" });
    await new Promise((r) => setTimeout(r, 10));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("nav.followLink for page links", () => {
  beforeEach(() => navigate.mockReset());

  it.each(["page", "tag"] as const)(
    "a %s link opens the page under its name as written, namespace kept (B-331, B-332)",
    (type) => {
      host().followLink({ type, name: "Projects/Aurora Launch" });
      // Not `/page/projects/aurora%20launch` (the lookup key), nor `Projects%2FAurora%20Launch`.
      expect(navigate).toHaveBeenCalledWith("/page/Projects/Aurora%20Launch");
    },
  );
});

describe("nav.followLink ends editing before it leaves the page (B-295)", () => {
  // The page being left stays mounted until the route has resolved the new one, and keys typed in
  // that gap went into the block being left. Every tree ends editing on `requestEditingEnd`.
  it.each([
    ["page", { type: "page", name: "Projects/Aurora" }],
    ["tag", { type: "tag", name: "aurora" }],
    ["block", { type: "block", id: "blk00000000001" }],
  ] as const)("a %s link", async (_kind, link) => {
    navigate.mockReset();
    const before = editingEndRequest();
    const ticksAtNavigate: number[] = [];
    navigate.mockImplementation(() => ticksAtNavigate.push(editingEndRequest()));
    host().followLink(link);
    // Asked at once, not once the block's page has been looked up.
    expect(editingEndRequest()).toBe(before + 1);
    await vi.waitFor(() => expect(ticksAtNavigate).toEqual([before + 1]));
    navigate.mockReset();
  });

  it("not for a web link, which opens in another tab", () => {
    const before = editingEndRequest();
    host().followLink({ type: "url", href: "https://example.com" });
    expect(editingEndRequest()).toBe(before);
  });
});

describe("createStore block-property writes (B-142)", () => {
  function store(accept: boolean) {
    const batches: OpBatch[] = [];
    const applied: Op[][] = [];
    let n = 0;
    return {
      batches,
      applied,
      store: createStore({
        editor: {
          commitOps: (batch) => {
            batches.push(batch);
            return accept;
          },
        },
        applyOps: async (ops) => {
          applied.push(ops);
        },
        getOpClock: async () => ({ next: () => `hlc${n++}`, device: "dev" }),
      }),
    };
  }

  it("commits a picked date and its repeat through the editor that shows the block, as one batch", async () => {
    const s = store(true);
    await s.store.setBlockProps("blk1", { scheduled: "2026-09-14", repeat: "1w" });
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.anchorId).toBe("blk1");
    // No focus: the caret stays wherever it is (a picker over the edited block, or none at all).
    expect(s.batches[0]?.focus).toBeUndefined();
    expect(s.batches[0]?.ops.map((o) => [o.entity, o.payload])).toEqual([
      ["blk1", { kind: "block.prop", key: "scheduled", value: "2026-09-14" }],
      ["blk1", { kind: "block.prop", key: "repeat", value: "1w" }],
    ]);
    // The editor took it: writing it here too would be a second copy the history never saw.
    expect(s.applied).toEqual([]);
  });

  it("a single property — a priority or marker from the palette — goes the same way", async () => {
    const s = store(true);
    await s.store.setBlockProp("blk2", "priority", "A");
    expect(s.batches.map((b) => b.ops.map((o) => o.payload))).toEqual([
      [{ kind: "block.prop", key: "priority", value: "A" }],
    ]);
    expect(s.applied).toEqual([]);
  });

  it("several blocks' properties go as ONE batch, anchored on the first block (B-346)", async () => {
    const s = store(true);
    await s.store.setPropsOfBlocks([
      { blockId: "blk1", props: { marker: "DONE", done: "2026-09-13T10:00:00Z" } },
      { blockId: "blk2", props: { marker: "DONE" } },
    ]);
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.anchorId).toBe("blk1");
    expect(s.batches[0]?.ops.map((o) => [o.entity, o.payload])).toEqual([
      ["blk1", { kind: "block.prop", key: "marker", value: "DONE" }],
      ["blk1", { kind: "block.prop", key: "done", value: "2026-09-13T10:00:00Z" }],
      ["blk2", { kind: "block.prop", key: "marker", value: "DONE" }],
    ]);
    expect(s.applied).toEqual([]);
  });

  it("writes nothing for an empty list of blocks", async () => {
    const s = store(true);
    await s.store.setPropsOfBlocks([]);
    expect(s.batches).toEqual([]);
    expect(s.applied).toEqual([]);
  });

  it("writes straight to the replica when no editor shows the block", async () => {
    const s = store(false);
    await s.store.setBlockProp("blk3", "marker", null);
    expect(s.batches).toHaveLength(1);
    expect(s.applied.map((ops) => ops.map((o) => o.payload))).toEqual([
      [{ kind: "block.prop", key: "marker", value: null }],
    ]);
  });
});
