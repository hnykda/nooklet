/**
 * The bugs this file exists for, all reported from real use against a served production build:
 *
 *  - typing exactly one character ended editing (a `<For>` keyed on rebuilt row objects recreated
 *    every row's DOM on each keystroke, tearing out the element the single CM6 surface lives in);
 *  - text typed before clicking away did not appear afterwards, only after a reload;
 *  - the served client had no API credential, so sync sat flapping "offline".
 */

import { expect, test } from "@playwright/test";
import { editor, openJournal, openPage, runName } from "../helpers/index.js";

// `openJournal` (helpers/editor.ts) guarantees a real, CodeMirror-backed outliner for TODAY. Today
// starts *virtual* (PLAN.md §8: "today is virtual until it has a block"), rendered by
// `VirtualJournalDay` as a plain `<textarea>`, and that two-stage handover is itself part of what
// made the original bug confusing: the first bullet typed fine because it was a textarea, and
// editing only died once CodeMirror took over. The handover has its own specs
// (`a-fresh-journal.spec.ts`, `journal-draft-sync.spec.ts`); these start past it.

test("types a whole sentence into a bullet without editing dying", async ({ page }) => {
  const outliner = await openJournal(page);

  const first = outliner.locator(".vr-block-view").first();
  await first.click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");

  // The regression: this used to stop after the first character.
  const sentence = "the quick brown fox";
  await page.keyboard.type(sentence, { delay: 20 });

  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText(sentence);
});

test("text survives blurring the block, without a reload", async ({ page }) => {
  const outliner = await openJournal(page);

  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" persisted text", { delay: 20 });

  // Click away — the surface detaches and the row must render what was typed.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(outliner).toContainText("persisted text");

  // And it must still be there after a full reload, i.e. it really reached the database.
  await page.reload();
  await expect(page.locator(".journal-day-today .vr-outliner")).toContainText("persisted text");
});

test("Enter creates a second bullet and both keep their text", async ({ page }) => {
  const outliner = await openJournal(page);

  // Today's journal is shared by every spec on the one e2e server, so how many rows it already has
  // depends on which specs ran first and whether their pushes landed before their browser context
  // closed (`a-fresh-journal.spec.ts` leaves two). An absolute "2" failed whenever that race went
  // the other way (B-233); what this test is about is that Enter added exactly ONE row.
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  const rowsBefore = await outliner.locator(".vr-row").count();
  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" first bullet", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("second bullet", { delay: 20 });

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // Row count, not just substrings: `toContainText` on the container also passes when both
  // strings land in ONE block, which is exactly how "Enter does nothing" hid here before.
  await expect(outliner.locator(".vr-row")).toHaveCount(rowsBefore + 1);
  await expect(outliner).toContainText("first bullet");
  await expect(outliner).toContainText("second bullet");

  await page.reload();
  const reloaded = page.locator(".journal-day-today .vr-outliner");
  await expect(reloaded).toContainText("first bullet");
  await expect(reloaded).toContainText("second bullet");
});

test("typing immediately after Enter is not discarded", async ({ page }, info) => {
  // Its own page: the specs share one server, so the journal accumulates state across tests and
  // this assertion needs an exactly-known starting point. Per repeat, too: with one fixed name the
  // second `--repeat-each` run found the first run's rows and failed on the count (B-292).
  const outliner = await openPage(page, runName("Enter Probe", info), "- alpha");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);

  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // No delay: `flushPendingEdit` used to drop this entirely, because the block had just been
  // created and was absent from the tree snapshot taken on the first keystroke.
  await page.keyboard.type("beta");

  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect(outliner).toContainText("beta");

  await page.reload();
  const reloaded = page.locator(".vr-outliner").first();
  await expect(reloaded.locator(".vr-row")).toHaveCount(2);
  await expect(reloaded).toContainText("alpha");
  await expect(reloaded).toContainText("beta");
});
