/**
 * A fresh client's first sync and today's virtual draft (PLAN.md §8: today is virtual until it has
 * a block).
 *
 * Every Playwright test gets a new browser context, so its replica starts empty, and every read of
 * it waits for the first sync. The stream used to draw today as a draft during that wait — before
 * anything knew whether today already existed. Typed text vanished when the sync swapped the draft
 * out (B-243, patched by appending it), and a draft committed with Enter or a blur created a second
 * page for a day the server already had: the server rejected it and every line after it, silently
 * (B-410). Now no draft is offered until the stream has answered. On the owner's 952-page graph the
 * wait is seconds long; here it is held open by routing `/sync/snapshot` until the test lets it
 * through, which is the same shape without needing the big graph.
 *
 * Writes to TODAY on the server, which several specs share (docs/BUGS.md B-32); it only appends
 * blocks with text no other spec uses, and `editing.spec.ts` has made today real by then in a full
 * run anyway.
 */

import { expect, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

test("today offers no draft until the first sync says whether today exists, and nothing typed after it is lost (B-243, B-410)", async ({
  page,
}) => {
  const today = isoOffset(0);
  // Unique per run: today is shared, and a repeat must not pass on the previous run's text.
  const stamp = Date.now().toString(36);
  const before = `on the server before ${stamp}`;
  const typed = `ztracený text ${stamp}`;
  await api(page, "page.append", { page: today, markdown: `- ${before}` });

  let release: () => void = () => {};
  const snapshotHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/sync/snapshot", async (route) => {
    await snapshotHeld;
    await route.continue();
  });

  await page.goto("/journals");
  const section = page.locator(".journal-day-today");
  // The replica cannot know yet whether today exists, so there is nothing to type into.
  await expect(section.locator(".vr-draft-loading")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(section.locator(".vr-draft-input")).toHaveCount(0);

  release();
  const outliner = section.locator(".vr-outliner");
  await expect(outliner).toContainText(before);
  await expect(section.locator(".vr-draft-loading")).toHaveCount(0);
  await expect(section.locator(".vr-draft-input")).toHaveCount(0);

  // And writing on the day that turned out to exist goes where it should.
  await outliner.locator(".vr-block-view", { hasText: before }).click();
  await expect(section.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(typed, { delay: 20 });
  await expect
    .poll(async () => (await readBlocks(page, today)).map((b) => b.content))
    .toContain(typed);
  const contents = (await readBlocks(page, today)).map((b) => b.content);
  expect(contents.indexOf(typed)).toBe(contents.indexOf(before) + 1);
});
