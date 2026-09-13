/**
 * Probe (2026-09-13, verifier of m11/keys-in-fields, B-300): the edges around "a key typed into a
 * field outside the outliner never acts on its blocks" that the branch's own tests do not reach.
 *
 * Prints `PROBE` lines; asserts only what it needs to get to the next step. Not part of the suite.
 * To re-run, copy it into `e2e/tests/` and:
 *   NOOKLET_E2E_PORT=<your port> pnpm e2e --project=chromium keys-in-fields-verify
 * then delete the copy. Case E writes to TODAY's journal — only on a throwaway e2e server.
 *
 * Answer at `499afcd` (Chromium, macOS, load average ~100, run once each):
 * - A: block 2 selected, title Tab → focus to the "History" link, stored depths unchanged; title
 *   Cmd+Enter → title commits (focus to body), blocks untouched; title Escape → selection stands,
 *   focus stays in the title, a following Backspace edits the title only.
 * - B: title → Cmd+K → Escape → focus back in the title (the draft " x" had committed on blur);
 *   Enter commits, selection stands, no edit opens.
 * - C: Settings "Journal template" `<select>` focused over a selection: Backspace, Cmd+Shift+D,
 *   Cmd+., Delete → blocks untouched. But after a selection Backspace deleted `kv one`, Cmd+Z on
 *   the focused select → stored `["0:kv one","0:kv two","0:kv three"]`: the deletion was undone
 *   behind the panel → B-452 (pre-existing), fixed by widening `textFieldOwnsKey` to every field
 *   outside the outliner; now asserted by `e2e/tests/keys-in-fields.spec.ts`.
 * - D: Czech + namespaced rename over a selection (`Kfv Čeština/Úpělivě ďábelské`, with a
 *   Backspace inside the title) → URL and page.read under the new name; a second browser context
 *   sees the three blocks; Backspace on a re-made selection syncs to it; Cmd+Z brings the block
 *   back in both.
 * - E: journals, a block of yesterday selected, click today's draft, type, Enter → today stored
 *   `["kfv draft",""]`, caret in today's new block, yesterday untouched; typing continues there.
 * - F: `a.page-history-link` focused over a selection, Enter → `block.editSelected` ran (editing=1,
 *   focus in `.cm-content`), link not followed. Same class as B-450 (buttons); evidence added there.
 *
 * Real-graph copy (owner's graph via sqlite3 .backup, served by this branch's build; not kept as a
 * file — the same keys driven by a one-off node script): on "Balení" (23 blocks) and
 * "TTRPG/VTM-alpha/Isabella D'Angelo" (13), title Cmd+Shift+D / Cmd+. / Tab / Cmd+Enter and palette
 * typing "příliš žluťoučký" + Backspace / Cmd+A / Cmd+X / Delete / Cmd+Shift+D / Cmd+. left page.read
 * identical with the selection standing. (Cmd+Enter IN the palette runs the highlighted row — the
 * palette's own Enter, by design, not the keymap.) `pnpm nooklet verify` afterwards: 20470 ops
 * replayed, OK — exact.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  api,
  isoOffset,
  MOD,
  openEditing,
  pagePath,
  readBlocks,
  rowTexts,
} from "../helpers/index.js";

const SEED = "- kv one\n- kv two\n- kv three";

async function state(page: Page, name: string, label: string): Promise<void> {
  await page.waitForTimeout(700);
  const outliner = page.locator(".vr-outliner").first();
  const stored = (await readBlocks(page, name).catch(() => [])).map(
    (b) => `${b.depth}:${b.content}`,
  );
  const selected = await outliner.locator(".vr-row-selected").count();
  const editing = await page.locator(".vr-outliner .cm-content").count();
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}#${el.id}.${el.className}` : "none";
  });
  console.log(
    `PROBE ${label}: stored=${JSON.stringify(stored)} selected=${selected} editing=${editing} active=${active} url=${page.url()}`,
  );
}

async function selectRow(page: Page, index: number): Promise<void> {
  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").nth(index).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
}

test("A: Tab / Shift+Tab / Cmd+Enter in the title with block 2 selected", async ({ page }) => {
  const name = "Kfv Title Tab";
  await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await selectRow(page, 1);
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press("Tab");
  await state(page, name, "A title Tab");
  await selectRow(page, 1);
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press(`${MOD}+Enter`);
  await state(page, name, "A title Cmd+Enter");
  await selectRow(page, 1);
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press("Escape");
  await state(page, name, "A title Escape");
  await page.keyboard.press("Backspace");
  await state(page, name, "A title Escape then Backspace (focus still title?)");
});

test("B: title -> Cmd+K -> Escape -> focus back -> Enter", async ({ page }) => {
  const name = "Kfv Title Palette";
  await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" x");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await state(page, name, "B after palette Escape");
  await page.keyboard.press("Enter");
  await state(page, `${name} x`, "B Enter after palette");
});

test("C: settings select over a selection", async ({ page }) => {
  const name = "Kfv Settings Select";
  await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+,`);
  const sel = page.locator("#set-journal-template");
  await sel.scrollIntoViewIfNeeded().catch(() => {});
  await sel.focus();
  for (const k of ["Backspace", `${MOD}+Shift+d`, `${MOD}+.`, "Delete"]) {
    await page.keyboard.press(k);
    await state(page, name, `C select ${k}`);
  }
  // Undo from a select after a real delete.
  await page.keyboard.press("Escape");
  await page.goto(pagePath(name));
  await selectRow(page, 0);
  await page.keyboard.press("Backspace");
  await state(page, name, "C deleted row 0");
  await page.keyboard.press(`${MOD}+,`);
  await page.locator("#set-journal-template").focus();
  await page.keyboard.press(`${MOD}+z`);
  await state(page, name, "C Cmd+Z on focused select");
  const css = page.locator("#set-custom-css");
  await css.focus();
  await page.keyboard.press(`${MOD}+z`);
  await state(page, name, "C Cmd+Z on custom css textarea");
});

test("D: Czech namespaced rename over a selection, second context, undo", async ({
  page,
  browser,
}) => {
  const name = "Kfv Čeština";
  const outliner = await openEditing(page, name, "- kv příliš\n- kv žluťoučký\n- kv kůň");
  await page.keyboard.press("Escape");
  await selectRow(page, 1);
  const title = page.locator("textarea.page-title-input");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type("/Úpělivě ďábelskéé");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  const renamed = `${name}/Úpělivě ďábelské`;
  await expect(page).toHaveURL(
    new RegExp(`${pagePath(renamed).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
  await state(page, renamed, "D renamed");
  const ctx2 = await browser.newContext();
  const other = await ctx2.newPage();
  await other.goto(pagePath(renamed));
  await expect(other.locator(".vr-outliner .vr-row")).toHaveCount(3, { timeout: 30_000 });
  console.log(
    `PROBE D other rows ${JSON.stringify(await rowTexts(other, other.locator(".vr-outliner").first()))}`,
  );
  await selectRow(page, 1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["kv příliš", "kv kůň"]);
  await expect
    .poll(() => rowTexts(other, other.locator(".vr-outliner").first()), { timeout: 30_000 })
    .toEqual(["kv příliš", "kv kůň"]);
  await page.keyboard.press(`${MOD}+z`);
  await state(page, renamed, "D after Cmd+Z");
  await expect
    .poll(() => rowTexts(other, other.locator(".vr-outliner").first()), { timeout: 30_000 })
    .toEqual(["kv příliš", "kv žluťoučký", "kv kůň"]);
  console.log(
    `PROBE D other after undo ${JSON.stringify(await rowTexts(other, other.locator(".vr-outliner").first()))}`,
  );
  await ctx2.close();
});

test("F: a focused link and button over a selection", async ({ page }) => {
  const name = "Kfv Link";
  await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  const link = page.locator("a[href]").first();
  console.log(`PROBE F link ${await link.evaluate((a) => a.outerHTML.slice(0, 200))}`);
  await link.focus();
  await page.keyboard.press("Enter");
  await state(page, name, "F link Enter");
});

test("E: journal draft Enter with a selection standing in another day", async ({ page }) => {
  const yesterday = isoOffset(-1);
  const today = isoOffset(0);
  await api(page, "page.append", { page: yesterday, markdown: "- kfv y one\n- kfv y two" });
  await page.goto("/journals");
  const draft = page.locator(".vr-draft-input").first();
  await expect(draft).toBeVisible();
  const tree = page.locator(".vr-outliner").first();
  await expect(tree.locator(".vr-row").first()).toBeVisible();
  await tree.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tree.locator(".vr-row-selected")).toHaveCount(1);
  await draft.click();
  console.log(
    `PROBE E after draft click selected=${await tree.locator(".vr-row-selected").count()}`,
  );
  await page.keyboard.type("kfv draft");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? `${el.tagName.toLowerCase()}.${el.className} in ${el.closest("[data-day],[class*=journal-day]")?.className}`
      : "none";
  });
  const y = (await readBlocks(page, yesterday).catch(() => [])).map((b) => b.content);
  const t = (await readBlocks(page, today).catch(() => [])).map((b) => b.content);
  console.log(
    `PROBE E Enter: yesterday=${JSON.stringify(y)} today=${JSON.stringify(t)} active=${active}`,
  );
  await page.keyboard.type("second");
  await page.waitForTimeout(1500);
  const t2 = (await readBlocks(page, today).catch(() => [])).map((b) => b.content);
  const y2 = (await readBlocks(page, yesterday).catch(() => [])).map((b) => b.content);
  console.log(`PROBE E typed: yesterday=${JSON.stringify(y2)} today=${JSON.stringify(t2)}`);
});
