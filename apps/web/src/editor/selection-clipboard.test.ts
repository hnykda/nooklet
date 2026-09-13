import { describe, expect, it, vi } from "vitest";
import { cutToClipboard, selectionMarkdown } from "./selection-clipboard.js";
import { tree as buildTree, makeBlock, orders } from "./test-helpers.js";

const [o1, o2, o3] = orders(3) as [string, string, string];

// parent ─ child
// other
// third
const t = buildTree(
  makeBlock({ id: "P", order: o1, content: "parent" }),
  makeBlock({ id: "C", order: o1, parentId: "P", content: "child", marker: "TODO" }),
  makeBlock({
    id: "O",
    order: o2,
    content: "other",
    properties: { "logseq.order-list-type": "number" },
  }),
  makeBlock({ id: "T", order: o3, content: "third" }),
);
const reading = ["P", "C", "O", "T"];

describe("selectionMarkdown (R31)", () => {
  it("writes each selected block with its subtree, once, in reading order", () => {
    // Selected bottom-up and with the child as well as its parent: the child is inside the
    // parent's subtree and must not be written a second time.
    const md = selectionMarkdown(t, ["O", "C", "P"], reading);
    expect(md).toMatch(/^- parent\n\s+- TODO child\n- other\n/);
    expect(md.match(/child/g)).toHaveLength(1);
    expect(md).not.toContain("third");
  });

  it("keeps a block's properties, so a numbered list pasted elsewhere stays one", () => {
    expect(selectionMarkdown(t, ["O"], reading)).toContain("logseq.order-list-type:: number");
  });

  it("skips an id that is no longer in the tree instead of throwing", () => {
    expect(selectionMarkdown(t, ["T", "gone"], [...reading, "gone"])).toMatch(/^- third\s*$/);
  });
});

describe("cutToClipboard (B-245)", () => {
  it("removes the blocks only after the clipboard write resolved", async () => {
    const order: string[] = [];
    let release!: () => void;
    const clipboard = {
      writeText: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              order.push("written");
              resolve();
            };
          }),
      ),
    };
    const pending = cutToClipboard("- x", clipboard, () => order.push("removed"));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await expect(pending).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("- x");
    expect(order).toEqual(["written", "removed"]);
  });

  it("deletes nothing where there is no clipboard (not a secure context)", async () => {
    const remove = vi.fn();
    await expect(cutToClipboard("- x", undefined, remove)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes nothing when the clipboard refuses the write", async () => {
    const remove = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const clipboard = {
      writeText: () => Promise.reject(new DOMException("Document is not focused")),
    };
    await expect(cutToClipboard("- x", clipboard, remove)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
