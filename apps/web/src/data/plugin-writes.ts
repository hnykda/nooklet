/**
 * Ops the client plugin host (`../plugins/host.ts`, ADR 023) builds for a plugin's `editor.*` write,
 * minted but NOT applied: the host commits them through the editor that shows the block, so the
 * write is one step of its undo history (B-108), and applies them itself only when no editor does.
 */
import { type Block, makeOp, newId, type Op, orderBetween } from "@nooklet/core";
import { getOpClock } from "./store.js";
import { firstChildOrder, type InsertPlacement, nextSiblingOrder, placeOf } from "./templates.js";

/**
 * `editor.insertBlockAfter(id, content)`: a new block with `content` as the next sibling of `blockId`
 * — after its children, before the sibling that followed it — and the `Block` it will be.
 * `undefined` when `blockId` is not a live block in the replica.
 *
 * With `placement` `"firstChildren"` the block is `blockId`'s first child instead: the host asks
 * for that when `blockId` is the zoom root of the view, whose siblings the view does not show
 * (R27.1; `/mermaid` on a zoom root, B-383).
 */
export async function blockAfterOps(
  blockId: string,
  content: string,
  placement: InsertPlacement = "after",
  now: number = Date.now(),
): Promise<{ ops: Op[]; block: Block } | undefined> {
  const place = await placeOf(blockId);
  if (!place) return undefined;
  const asChild = placement === "firstChildren";
  const parentId = asChild ? blockId : place.parent_id;
  const order = asChild
    ? orderBetween(null, await firstChildOrder(place.page_id, blockId))
    : orderBetween(place.order_key, await nextSiblingOrder(place));
  const clock = await getOpClock(1);
  const block: Block = {
    id: newId(now),
    pageId: place.page_id,
    parentId,
    order,
    content,
    marker: null,
    priority: null,
    properties: {},
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };
  const op = makeOp(clock.next(), clock.device, block.id, {
    kind: "block.create",
    place: { pageId: block.pageId, parentId: block.parentId, order: block.order },
    content,
    createdAt: now,
  });
  return { ops: [op], block };
}
