/**
 * `EditorHost.currentBlock()` on the tree's side: the block being edited as `@nooklet/core`'s
 * `Block`, the shape a plugin is typed against (`editor.currentBlock()`, ADR 023 — `/mermaid` reads
 * it, B-344). Mirrors `data/plugin-lookups.ts#loadBlock` field for field, so a plugin sees the same
 * block from the editor as from the replica: the reserved scheduling fields folded back into
 * `properties` (ADR 011), and the live buffer — typed text and property lines not yet flushed —
 * split back into content and properties (B-101).
 *
 * Pure, so it is unit-tested without a DOM.
 */
import { type Block, formatDoneIso, type Properties } from "@nooklet/core";
import type { BlockTreeNode } from "../data/types.js";
import { withEditText } from "./editText.js";
import type { EditableBlock } from "./types.js";

export function toCoreBlock(
  block: EditableBlock,
  pageId: string,
  liveText: string,
  /** From the fetched page tree; a block created moments ago is not in it yet, and gets `now`. */
  times: { createdAt: number; updatedAt: number } | undefined,
  now: number = Date.now(),
): Block {
  const live = withEditText(block, liveText);
  const properties: Properties = { ...live.properties };
  if (live.scheduled !== null) properties.scheduled = live.scheduled;
  if (live.deadline !== null) properties.deadline = live.deadline;
  if (live.repeat !== null) properties.repeat = live.repeat;
  if (live.doneAt !== null) properties.done = formatDoneIso(live.doneAt);
  return {
    id: live.id,
    pageId,
    parentId: live.parentId,
    order: live.order,
    content: live.content,
    marker: live.marker,
    priority: live.priority,
    properties,
    collapsed: live.collapsed,
    createdAt: times?.createdAt ?? now,
    updatedAt: times?.updatedAt ?? now,
  };
}

/** `id`'s node in a fetched page tree, or `undefined`. */
export function findTreeNode(
  nodes: readonly BlockTreeNode[],
  id: string,
): BlockTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inside = findTreeNode(n.children, id);
    if (inside) return inside;
  }
  return undefined;
}
