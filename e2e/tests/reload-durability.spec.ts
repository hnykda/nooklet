/**
 * An edit must survive a reload that comes before the replica has written it (B-247), and one
 * written just before a reload must still reach the server afterwards (B-301).
 *
 * Every write goes to the DB worker as a message and only becomes durable (local state plus the
 * `pending_op` outbox, one transaction) when the worker runs it. A worker still busy with an
 * earlier task — a first sync, a block search on a big graph, a page's queries — has the message
 * queued, and an unloading document takes its worker and that queue with it. The worker is kept
 * busy here with a synchronous loop evaluated inside it, the same shape as a long SQLite call.
 */

import { expect, type Page, test } from "@playwright/test";
import { openEditing, readBlocks } from "../helpers/index.js";

/** Blocks the replica's worker for `ms`. Never awaited: the reload ends the worker first. */
function occupyReplica(page: Page, ms: number): void {
  const worker = page.workers().find((w) => w.url().includes("db.worker"));
  if (!worker) throw new Error(`no db worker among ${page.workers().map((w) => w.url())}`);
  void worker
    .evaluate((duration) => {
      const end = Date.now() + duration;
      while (Date.now() < end) {
        // busy: nothing else runs on this thread until the loop ends
      }
    }, ms)
    .catch(() => {
      // The reload destroys the worker mid-loop; that is the point.
    });
}

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

for (const [label, waitMs] of [
  // Past the editor's 500 ms text debounce: the op was handed to the worker and sat in its queue.
  ["after the text debounce", 1_200],
  // Inside the debounce: only the pagehide flush hands it over, into the same busy queue.
  ["inside the text debounce", 150],
] as const) {
  test(`an edit queued behind a busy replica survives a reload ${label} (B-247)`, async ({
    page,
  }) => {
    // Unique per run, so a repeat does not reopen a page an earlier run already typed into.
    const name = `Reload Durability B247 ${label} ${Date.now().toString(36)}`;
    const outliner = await openEditing(page, name, "- x");
    // Let the page's own load work finish, so the busy loop below is the only thing in the way.
    await page.waitForTimeout(800);
    occupyReplica(page, 4_000);
    await page.keyboard.type(" queued", { delay: 20 });
    await page.waitForTimeout(waitMs);
    await page.reload();
    await expect(outliner.locator(".vr-row").first()).toBeVisible();

    await expect.poll(() => stored(page, name), { timeout: 15_000 }).toEqual(["x queued"]);
    await expect(page.locator(".vr-outliner").first()).toContainText("x queued");
  });
}

test("an edit written just before a reload is pushed after it, with no further edit (B-301)", async ({
  page,
}) => {
  const name = `Reload Durability B301 push ${Date.now().toString(36)}`;
  await openEditing(page, name, "- x");
  await page.waitForTimeout(800);
  await page.keyboard.type(" pushed", { delay: 20 });
  // Long enough for the 500 ms text debounce to hand the op to an idle worker, short of the
  // 300 ms push debounce that follows it: durable in the replica, not yet on the server.
  await page.waitForTimeout(650);
  await page.reload();
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner).toContainText("x pushed");

  // Nothing is typed after the reload: before the fix the outbox waited for the next local write.
  await expect.poll(() => stored(page, name), { timeout: 10_000 }).toEqual(["x pushed"]);
});
