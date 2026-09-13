/**
 * The "Created … · Edited …" line at the foot of the block context menu (audit §2 #15).
 *
 * Pure so it can be tested without a clock or a replica. The words come from `formatWhen`, the
 * same recency wording the History and Trash views use, so one block's "5 minutes ago" reads the
 * same wherever it appears.
 *
 * What the two numbers mean, because neither is what the label alone suggests:
 * - `createdAt` is the `block.create` payload's time. For an imported Logseq graph that is the
 *   markdown file's mtime at import (`importer/logseq.ts`), not when the bullet was first typed —
 *   Logseq's files do not record it.
 * - `updatedAt` moves only on `block.text` (`core/sync/apply-ops.ts#applyBlockText`): a text
 *   edit. Marking a task done, collapsing or moving the block leave it alone, which is why the
 *   label says "Edited" rather than "Updated".
 */

import { formatWhen } from "../views/historyText.js";

export interface BlockTimes {
  createdAt: number;
  updatedAt: number;
}

/** "Created today 14:03" or "Created 3 Sep 2026 09:15 · Edited 5 minutes ago". The edit half is
 * omitted when the text was never changed after creation — "Edited" equal to "Created" is noise. */
export function blockTimesLabel(times: BlockTimes, now: number = Date.now()): string {
  const created = `Created ${formatWhen(new Date(times.createdAt).toISOString(), now)}`;
  if (times.updatedAt <= times.createdAt) return created;
  return `${created} · Edited ${formatWhen(new Date(times.updatedAt).toISOString(), now)}`;
}

/** The exact local date-times, for the line's tooltip: the label rounds to minutes or to words. */
export function blockTimesTitle(times: BlockTimes): string {
  const created = `Created ${new Date(times.createdAt).toLocaleString()}`;
  if (times.updatedAt <= times.createdAt) return created;
  return `${created}\nEdited ${new Date(times.updatedAt).toLocaleString()}`;
}
