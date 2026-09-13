/**
 * The `[[` popup's "New page" row while the local replica is busy (B-244).
 *
 * Every read and write of the replica goes through one worker, and every SQLite call there is
 * synchronous: while it applies a first sync on a big graph (the owner's 952 pages), a request
 * like "create this page" waits its turn, seconds on a fresh client. Anything the UI makes wait on
 * that request is frozen for as long. Here the worker is kept busy on purpose, with a synchronous
 * loop evaluated inside it, which is the same shape as a long snapshot insert without needing the
 * big graph.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, editorText, openEditing, readBlocks } from "../helpers/index.js";

/** Blocks the replica's worker for `ms`. Not awaited by the caller until it wants the worker back. */
function occupyReplica(page: Page, ms: number): Promise<void> {
  const worker = page.workers().find((w) => w.url().includes("db.worker"));
  if (!worker) throw new Error(`no db worker among ${page.workers().map((w) => w.url())}`);
  return worker.evaluate((duration) => {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      // busy: nothing else runs on this thread until the loop ends
    }
  }, ms);
}

test("New page links at once and keeps what is typed next, even while the replica is busy (B-244)", async ({
  page,
}) => {
  // Unique per run, so a repeat does not reopen the page an earlier run already wrote to.
  const stamp = Date.now().toString(36);
  const name = `Busy Replica New Page ${stamp}`;
  await openEditing(page, name, "- x");
  const title = `busy-replica/${stamp}`;
  await page.keyboard.type(` [[${title}`);
  const popup = page.locator(".cmd-popup");
  const create = popup.locator('[role="option"]').filter({ hasText: `New page "${title}"` });
  await expect(create).toHaveClass(/cmd-row--active/);

  const busy = occupyReplica(page, 3_000);
  await page.keyboard.press("Enter");
  // Before the fix the link text waited for the page to be created in the replica: for as long
  // as the worker was busy the editor still said `[[title` with the popup open, and whatever was
  // typed meanwhile raced the late insertion.
  await expect.poll(() => editorText(page), { timeout: 1_500 }).toBe(`x [[${title}]]`);
  await expect(popup).toHaveCount(0, { timeout: 1_500 });
  await page.keyboard.type(" after");
  await busy;

  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual([`x [[${title}]] after`]);
  // And the page itself still gets created.
  await expect
    .poll(async () => {
      try {
        const r = await api<{ page: { kind: string } }>(page, "page.read", { page: title });
        return r.page.kind;
      } catch {
        return "missing";
      }
    })
    .toBe("page");
  // No DOM-text check of the editor here: with the caret now past the link, live preview hides
  // its brackets, so the stored block above is the record of what the editor holds.
});
