/**
 * A fresh client's first sync racing the virtual journal draft (PLAN.md §8: today is virtual until
 * it has a block).
 *
 * Every Playwright test gets a new browser context, so its replica starts empty: the stream draws
 * today as a draft before the snapshot says today already exists, then swaps the draft for the
 * real outliner. On the owner's 952-page graph that window is seconds long; here it is held open
 * by routing `/sync/snapshot` until the test lets it through, which is the same shape of data
 * without needing the big graph.
 *
 * Writes to TODAY on the server, which several specs share (docs/BUGS.md B-32); it only appends
 * one block with text no other spec uses, and `editing.spec.ts` has made today real by then in a
 * full run anyway.
 */

import { expect, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

test("text typed into today's draft survives the first sync saying today already exists (B-243)", async ({
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
  const draft = section.locator(".vr-draft-input");
  await expect(draft).toBeVisible();
  await draft.click();
  await page.keyboard.type(typed, { delay: 20 });
  // Still the draft: the replica has not heard about today yet.
  await expect(draft).toHaveValue(typed);

  release();
  await expect(section.locator(".vr-outliner")).toBeVisible();
  await expect
    .poll(async () => (await readBlocks(page, today)).map((b) => b.content))
    .toContain(typed);

  // Where it went is where you can keep writing: the caret is in that block, at its end.
  await expect(section.locator(".cm-content")).toBeFocused();
  await page.keyboard.type(" dál");
  await expect
    .poll(async () => (await readBlocks(page, today)).map((b) => b.content))
    .toContain(`${typed} dál`);
  const contents = (await readBlocks(page, today)).map((b) => b.content);
  expect(contents.indexOf(`${typed} dál`)).toBeGreaterThan(contents.indexOf(before));
});
