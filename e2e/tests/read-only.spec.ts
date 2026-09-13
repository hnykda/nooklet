/**
 * The read-only page lock (audit §2 #17, B-234): `read-only:: true` on a page keeps its blocks out
 * of edit mode and refuses the writes a click or a key would make, with a short notice — in the
 * page view and in the journal stream — and lifting the property unlocks the open page at once.
 *
 * What these deliberately do NOT claim: that the API or an agent is stopped. The lock is UI-only
 * (docs/spec/markdown-grammar.md OUT-21a); one test below edits a locked page through the API.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  editor,
  isoOffset,
  MOD,
  openEditing,
  openPage,
  pagePath,
  readBlocks,
  rowDepths,
} from "../helpers/index.js";

function notice(page: Page): Locator {
  return page.locator(".vr-readonly-notice");
}

const LOCKED = "- TODO locked task\n- second line\n  - child";

/** Create a page with `read-only:: true` and open it. Through `properties`, not a `read-only::`
 * line in the markdown: `page.create` drops a markdown pre-block's page properties (B-235). */
async function openLocked(page: Page, name: string, markdown = LOCKED): Promise<Locator> {
  await api(page, "page.create", {
    name,
    if_exists: "return",
    properties: { "read-only": "true" },
    markdown,
  });
  const outliner = await openPage(page, name, markdown);
  await expect(page.locator(".page-readonly-badge")).toBeVisible();
  return outliner;
}

test("a locked page renders but never enters edit mode, and says why", async ({ page }) => {
  const outliner = await openLocked(page, "Locked Basics");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await expect(page.locator(".page-readonly-badge")).toBeVisible();
  await expect(page.locator("input.page-title-input")).toHaveAttribute("readonly", "");

  // Click into a block: no editor, a notice instead.
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("read-only");
  await expect(editor(page)).toHaveCount(0);

  // Enter on a keyboard-focused block does not edit either.
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("xyz");
  await expect(editor(page)).toHaveCount(0);

  // The task marker refuses too, and stays TODO.
  await outliner.locator(".vr-marker").first().click();
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);

  const stored = await api<{ text: string }>(page, "page.read", { page: "Locked Basics" });
  expect(stored.text).toContain("TODO locked task");
  expect((await readBlocks(page, "Locked Basics")).map((b) => b.content)).toEqual([
    "locked task",
    "second line",
    "child",
  ]);
});

test("a locked page offers no block selection, so selection keys and block commands write nothing", async ({
  page,
}) => {
  const outliner = await openLocked(page, "Locked Selection");
  await outliner
    .locator(".vr-row")
    .nth(1)
    .locator(".vr-block-view")
    .click({ modifiers: [MOD === "Meta" ? "Meta" : "Control"] });
  // Without this guard a selection DID get around the lock: Tab indented, Backspace deleted and
  // Cmd/Ctrl+Enter cycled the marker through the store (checked by removing it, 2026-09-13).
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(0);
  for (const key of ["Backspace", "Tab", "Alt+ArrowUp", `${MOD}+Enter`]) {
    await page.keyboard.press(key);
  }
  // Local state first — an edit would show here at once, before any sync.
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 1]);
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);
  // Right-click: no block command is offered (their `when` needs editing or a selection).
  await outliner.locator(".vr-row").nth(0).click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(page.locator(".ctx-menu .ctx-item")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // …nor in the palette.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(">Cycle task");
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await expect(page.locator(".cmd-palette", { hasText: "Cycle task state" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Then the server, once nothing is left to push.
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  const blocks = await readBlocks(page, "Locked Selection");
  expect(blocks.map((b) => [b.content, b.depth])).toEqual([
    ["locked task", 0],
    ["second line", 0],
    ["child", 1],
  ]);
  const stored = await api<{ text: string }>(page, "page.read", { page: "Locked Selection" });
  expect(stored.text).toContain("TODO locked task");
});

test("the text of a locked block can be selected with the mouse, without a notice", async ({
  page,
}) => {
  const outliner = await openLocked(page, "Locked Copy", "- copy these words");
  const view = outliner.locator(".vr-row").first().locator(".vr-block-view");
  const box = await view.boundingBox();
  if (!box) throw new Error("no box for the block view");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("copy");
  await expect(notice(page)).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
});

test("collapsing still works on a locked page", async ({ page }) => {
  const outliner = await openLocked(page, "Locked Collapse");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await outliner.locator(".vr-row").nth(1).locator(".vr-collapse-arrow").click();
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
});

test("unlocking takes effect on the open page, and locking ends an edit in progress", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Lock Live", "- editable");
  await page.keyboard.type(" text");
  await expect(editor(page)).toBeFocused();

  // An agent (or another device) locks the page while it is being edited.
  await api(page, "page.update", { page: "Lock Live", properties: { "read-only": "true" } });
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator(".page-readonly-badge")).toBeVisible();
  // What had been typed was kept, not thrown away by the lock.
  await expect
    .poll(async () => (await readBlocks(page, "Lock Live"))[0]?.content)
    .toBe("editable text");
  await outliner.locator(".vr-row").first().locator(".vr-block-view").click();
  await expect(editor(page)).toHaveCount(0);

  // The lock is not a permission: the API still writes to a locked page.
  await api(page, "page.append", { page: "Lock Live", markdown: "- appended by an agent" });
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await api(page, "page.update", { page: "Lock Live", properties: { "read-only": null } });
  await expect(page.locator(".page-readonly-badge")).toHaveCount(0);
  await outliner.locator(".vr-row").first().locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
});

test("locking a journal day from its properties panel locks it in the journal stream too", async ({
  page,
}) => {
  // Two days back: an offset no other spec writes to (journals.spec uses -3/-5/-7, views -11…).
  const day = isoOffset(-2);
  await api(page, "page.append", { page: day, markdown: "- locked journal line" });

  // Through the UI: `page.update` refuses every change to a journal day, properties included
  // (B-236).
  await page.goto(pagePath(day));
  await page.locator(".page-properties-toggle").click();
  await page.locator(".page-property-add-key").fill("read-only");
  await page.locator(".page-property-add-value").fill("true");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-readonly-badge")).toBeVisible();

  await page.goto("/journals");
  const section = page.locator(".journal-day", { hasText: "locked journal line" });
  await expect(section.locator(".vr-row")).toHaveCount(1);
  await section.locator(".vr-block-view").first().click();
  await expect(notice(page)).toBeVisible();
  await expect(section.locator(".cm-content")).toHaveCount(0);
});
