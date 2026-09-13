/**
 * Writing to a journal day that may have come into existence behind the caller's back.
 *
 * `views/VirtualJournalDay.tsx` shows a day as a draft while the local replica has no page for it.
 * On a fresh client the first sync can reveal that the page exists after all (another device
 * wrote today) while someone is typing into that draft; the stream then swaps the draft for the
 * real outliner and the typed text needs somewhere to go (B-243). It goes at the end of the page
 * the replica now has, as an ordinary block through the normal op path.
 */

import { makeOp, newId, orderBetween } from "@nooklet/core";
import { queryAs } from "../db/client.js";
import { applyOps, getOpClock } from "./store.js";

/**
 * Append `content` as the last top-level block of `day`'s journal page. Returns the new block's
 * id, or `null` when the local replica has no live page for that day (nothing is written then:
 * creating the day is `VirtualJournalDay`'s own job, template and all).
 */
export async function appendToJournalDay(day: number, content: string): Promise<string | null> {
  const [page] = await queryAs<{ id: string }>(
    "SELECT id FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
    [day],
  );
  if (!page) return null;
  // Same order as `compareOrder` (plain string comparison, then id): order keys are ASCII, where
  // SQLite's BINARY collation agrees with JavaScript's `<`.
  const [last] = await queryAs<{ order_key: string }>(
    `SELECT order_key FROM block
      WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL
      ORDER BY order_key DESC, id DESC LIMIT 1`,
    [page.id],
  );
  const clock = await getOpClock(1);
  const op = makeOp(clock.next(), clock.device, newId(), {
    kind: "block.create",
    place: { pageId: page.id, parentId: null, order: orderBetween(last?.order_key ?? null, null) },
    content,
    createdAt: Date.now(),
  });
  await applyOps([op]);
  return op.entity;
}
