/**
 * What a block selection puts on the clipboard (R31): `block.copySelection` (B-84) and
 * `block.cutSelection` (B-245). One module for both, so a cut can never copy something other than
 * what Copy would have — the text comes from the same function either way.
 *
 * Pure except for `cutToClipboard`'s injected clipboard; `BlockTree.tsx` owns the commit.
 */
import { type OutlineNode, serializeOutline } from "@nooklet/core";
import { childrenIds, getBlock } from "./tree.js";
import type { BlockId, EditorTree } from "./types.js";

/**
 * The selection as outline markdown, subtrees included, through the same serializer the mirror
 * uses (ids omitted) — so what you paste elsewhere is exactly what a page file would say. A block
 * whose ancestor is also selected is already inside that ancestor's subtree and is written once.
 * Roots come out in `readingOrder` (the rows as shown), not in the order they were selected.
 */
export function selectionMarkdown(
  tree: EditorTree,
  selectedIds: readonly BlockId[],
  readingOrder: readonly BlockId[],
): string {
  const chosen = new Set(selectedIds);
  const inSelectedAncestor = (id: BlockId): boolean => {
    let cur = getBlock(tree, id).parentId;
    while (cur !== null) {
      if (chosen.has(cur)) return true;
      cur = getBlock(tree, cur).parentId;
    }
    return false;
  };
  const toNode = (id: BlockId): OutlineNode => {
    const b = getBlock(tree, id);
    return {
      content: b.content,
      marker: b.marker,
      priority: b.priority,
      // Copied blocks keep their properties — a numbered list pasted elsewhere stays one.
      properties: { ...b.properties },
      collapsed: b.collapsed,
      children: childrenIds(tree, id).map(toNode),
    };
  };
  const roots = readingOrder.filter(
    (id) => chosen.has(id) && tree.byId.has(id) && !inSelectedAncestor(id),
  );
  return serializeOutline({ properties: {}, blocks: roots.map(toNode) }, { ids: "none" });
}

/** The part of `navigator.clipboard` a cut needs; absent outside a secure context. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/**
 * Write `text`, and only once the write has SUCCEEDED run `remove`. Resolves to whether it did.
 *
 * The order is the point. Deleting first and copying after would lose the blocks from the page
 * whenever the clipboard is missing or refuses: `navigator.clipboard` does not exist at all over
 * plain http from another machine (a LAN address is not a secure context), and a write rejects if
 * the document lost focus in between. Undo would bring them back, but a cut that silently copied
 * nothing reads as "my blocks are gone". So no clipboard, no delete.
 */
export async function cutToClipboard(
  text: string,
  clipboard: ClipboardWriter | undefined,
  remove: () => void,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
  } catch (err) {
    console.error("nooklet: cut could not write the clipboard; nothing was deleted", err);
    return false;
  }
  remove();
  return true;
}
