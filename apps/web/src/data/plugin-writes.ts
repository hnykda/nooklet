/**
 * Ops the client plugin host (`../plugins/host.ts`, ADR 023) builds for a plugin's `editor.*` write,
 * minted but NOT applied: the host commits them through the editor that shows the block, so the
 * write is one step of its undo history (B-108), and applies them itself only when no editor does.
 */
import { type Block, makeOp, newId, type Op, orderBetween } from "@nooklet/core";
import { getOpClock } from "./store.js";
import { nextSiblingOrder, placeOf } from "./templates.js";

/**
 * `editor.insertBlockAfter(id, content)`: a new block with `content` as the next sibling of `blockId`
 * — after its children, before the sibling that followed it — and the `Block` it will be.
 * `undefined` when `blockId` is not a live block in the replica.
 */
export async function blockAfterOps(
  blockId: string,
  content: string,
  now: number = Date.now(),
): Promise<{ ops: Op[]; block: Block } | undefined> {
  const place = await placeOf(blockId);
  if (!place) return undefined;
  const upper = await nextSiblingOrder(place);
  const clock = await getOpClock(1);
  const block: Block = {
    id: newId(now),
    pageId: place.page_id,
    parentId: place.parent_id,
    order: orderBetween(place.order_key, upper),
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
