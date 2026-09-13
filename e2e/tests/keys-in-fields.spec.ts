/**
 * Keys typed into a field outside the outliner while a block selection stands (B-300).
 *
 * The global keymap listens on `document` in the capture phase, so it sees a keydown before the
 * page title, the palette's query or the find bar does. With a block selected, keys typed there
 * ran block commands on a selection the user was not looking at — Enter in the title opened the
 * block instead of committing the name, Cmd/Ctrl+Shift+D in the title or the palette duplicated
 * the block, Cmd/Ctrl+. zoomed into it, and a formatting shortcut in the palette over an open edit
 * wrote into the block behind it. Backspace and Cmd/Ctrl+X were the first reported (and are kept
 * here); B-347's key list had already taken those back for the field.
 *
 * What is stored is read back through `page.read`. Page names carry the run's repeat/retry index,
 * because a rename cannot be undone by the next run.
 */

import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { MOD, openEditing, pagePath, readBlocks, rowTexts } from "../helpers/index.js";

const SEED = "- kf one\n- kf two\n- kf three";
const SEEDED = ["kf one", "kf two", "kf three"];

function runName(base: string, info: TestInfo): string {
  return `${base} ${info.repeatEachIndex}-${info.retry}`;
}

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("Backspace and Cmd/Ctrl+X in the page title edit the title, and Enter renames the page, with a block selected (B-300)", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = runName("Keys Title Selection", info);
  const outliner = await openEditing(page, name, SEED);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("Escape");
  const selected = outliner.locator(".vr-row-selected");
  await expect(selected).toHaveCount(1);

  const title = page.locator("textarea.page-title-input");
  await title.click();
  // Cmd/Ctrl+A too is a selection command (`block.selectAll`); here it selects the title's text.
  // (Not End then Shift+Home: a long title wraps, and Shift+Home selects one visual line.)
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+x`);
  await expect(title).toHaveValue("");
  await expect.poll(() => clipboard(page)).toBe(name);

  await page.keyboard.type(`${name} renamedd`);
  await page.keyboard.press("Backspace");
  await expect(title).toHaveValue(`${name} renamed`);
  // The selection stands and nothing happened to the blocks.
  await expect(selected).toHaveCount(1);
  expect(await rowTexts(page, outliner)).toEqual(SEEDED);

  // Enter is the title's: it commits the name. It used to open the selected block for editing.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${pagePath(`${name} renamed`)}$`));
  await expect(page.locator(".vr-outliner .cm-content")).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  expect(await stored(page, `${name} renamed`)).toEqual(SEEDED);
});

test("Cmd/Ctrl+Shift+D and Cmd/Ctrl+. in the page title leave the selected block alone (B-300)", async ({
  page,
}, info) => {
  const name = runName("Keys Title Block Shortcuts", info);
  const outliner = await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);

  const title = page.locator("textarea.page-title-input");
  await title.click();
  await page.keyboard.press(`${MOD}+Shift+d`); // block.duplicate
  await page.keyboard.press(`${MOD}+.`); // block.zoomIn
  await page.keyboard.press("Tab"); // block.indentSelected, on a block that could not indent anyway
  await expect(title).toHaveValue(name);

  await page.waitForTimeout(500);
  expect(await rowTexts(page, outliner)).toEqual(SEEDED);
  await expect(page.locator(".vr-zoom-trail")).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  expect(await stored(page, name)).toEqual(SEEDED);
});

test("Backspace, Cmd/Ctrl+A then Cmd/Ctrl+X in the palette edit the query, not the selected block (B-300)", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = runName("Keys Palette Selection", info);
  const outliner = await openEditing(page, name, SEED);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("Escape");
  const selected = outliner.locator(".vr-row-selected");
  await expect(selected).toHaveCount(1);

  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  const input = palette.locator(".cmd-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("abcd");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("abc");
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+x`);
  await expect(input).toHaveValue("");
  await expect.poll(() => clipboard(page)).toBe("abc");

  // Block shortcuts typed into the query do nothing to the page behind it either.
  await page.keyboard.press(`${MOD}+Shift+d`);
  await page.keyboard.press(`${MOD}+.`);
  await expect(palette).toBeVisible();
  await page.waitForTimeout(500);

  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(selected).toHaveCount(1);
  expect(await rowTexts(page, outliner)).toEqual(SEEDED);
  await expect(page.locator(".vr-zoom-trail")).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  expect(await stored(page, name)).toEqual(SEEDED);
});

test("a shortcut typed into the palette over an open edit does not write into the block behind it (B-300)", async ({
  page,
}, info) => {
  const name = runName("Keys Palette Over Edit", info);
  await openEditing(page, name, SEED);
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const input = page.locator(".cmd-palette .cmd-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("abc");
  await page.keyboard.press(`${MOD}+Shift+k`); // format.insertLink: `[]()` at the caret
  await page.keyboard.press(`${MOD}+b`); // format.bold
  await expect(input).toHaveValue("abc");

  // Escape gives the editor its caret back, at the end of the block, where typing goes on.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  await expect.poll(() => stored(page, name)).toEqual(["kf one!", "kf two", "kf three"]);
});

test("with no field focused, a standing selection still answers Backspace and Cmd/Ctrl+X, also after the palette or the page title had focus (B-300)", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = runName("Keys Selection No Field", info);
  const outliner = await openEditing(page, name, "- kf one\n- kf two\n- kf three\n- kf four");
  const selected = outliner.locator(".vr-row-selected");

  // Straight from editing: Escape selects the block, Backspace deletes it.
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["kf two", "kf three", "kf four"]);

  // Through the palette and out again: the outliner has its keys back, Cmd/Ctrl+X cuts.
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  await expect(selected).toHaveCount(1);
  await page.keyboard.press(`${MOD}+x`);
  await expect.poll(() => clipboard(page)).toMatch(/^- kf two\s*$/);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["kf three", "kf four"]);

  // And after the page title: Enter commits it and leaves focus outside any field.
  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press("Enter");
  await expect(page.locator("textarea.page-title-input")).not.toBeFocused();
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["kf four"]);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  await expect.poll(() => stored(page, name)).toEqual(["kf four"]);
});

test("over a block selection, the keys meant for a field still work there (B-300)", async ({
  page,
}, info) => {
  const name = runName("Keys Field Commands", info);
  const outliner = await openEditing(page, name, SEED);
  const selected = outliner.locator(".vr-row-selected");
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);

  // Cmd/Ctrl+K from the page title opens the palette; Cmd/Ctrl+K in its query closes it again.
  await page.locator("textarea.page-title-input").click();
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  const input = palette.locator(".cmd-input");
  await expect(input).toBeFocused();
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toHaveCount(0);

  // The palette still offers the selection's commands, and its arrows and Enter run one.
  await page.keyboard.press(`${MOD}+k`);
  await expect(input).toBeFocused();
  await page.keyboard.type(">Duplicate block");
  await expect(palette.locator(".cmd-row").first()).toContainText("Duplicate block");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(palette.locator(".cmd-row--active")).toContainText("Duplicate block");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect
    .poll(() => rowTexts(page, outliner))
    .toEqual(["kf one", "kf one", "kf two", "kf three"]);

  // The find bar, over a selection: Cmd/Ctrl+F inside it keeps it, Enter steps, Escape closes it.
  await page.keyboard.press("Escape");
  await outliner.locator(".vr-block-view").nth(2).click();
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press(`${MOD}+f`);
  const find = page.locator(".page-find-input");
  await expect(find).toBeFocused();
  await page.keyboard.type("kf");
  await page.keyboard.press(`${MOD}+f`);
  await expect(find).toBeFocused();
  await expect(page.locator(".page-find-count")).toHaveText(/of 4/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-find-count")).toHaveText(/^2 of 4$/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-find")).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  await expect.poll(() => stored(page, name)).toEqual(["kf one", "kf one", "kf two", "kf three"]);
});

test("the global shortcuts still fire from the search box and from a settings field (B-300)", async ({
  page,
}, info) => {
  const name = runName("Keys Global From Fields", info);
  const outliner = await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);

  // Cmd/Ctrl+Shift+F from the selection opens search; Cmd/Ctrl+J typed in its box goes to today.
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(page).toHaveURL(/\/search$/);
  const search = page.locator(".search-query-input");
  await search.click();
  await page.keyboard.type("kf");
  await expect(search).toBeFocused();
  await page.keyboard.press(`${MOD}+j`);
  await expect(page).toHaveURL(/\/journals$/);

  // Cmd/Ctrl+, opens settings; Cmd/Ctrl+K from a focused setting opens the palette over it.
  await page.keyboard.press(`${MOD}+,`);
  const format = page.locator("#set-journal-format");
  await expect(format).toBeVisible();
  await format.focus();
  await expect(format).toBeFocused();
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  expect(await stored(page, name)).toEqual(SEEDED);
});

test("Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z on a focused select do not take back a block deletion behind Settings (B-452)", async ({
  page,
}, info) => {
  const name = runName("Keys Undo From Select", info);
  const outliner = await openEditing(page, name, SEED);
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => stored(page, name)).toEqual(["kf two", "kf three"]);

  // `edit.undo`/`edit.redo` are `when: true`, so hiding the outliner (R12b) did not stop them: from
  // the focused select, Cmd/Ctrl+Z brought the deleted block back behind the panel.
  await page.keyboard.press(`${MOD}+,`);
  const select = page.locator("#set-journal-template");
  await select.focus();
  await expect(select).toBeFocused();
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(700);
  await expect(select).toBeFocused();
  expect(await rowTexts(page, outliner)).toEqual(["kf two", "kf three"]);
  expect(await stored(page, name)).toEqual(["kf two", "kf three"]);

  // Out of the field, the outliner's undo still takes the deletion back.
  await page.locator(".set-close").click();
  await expect(select).toHaveCount(0);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(SEEDED);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  await expect.poll(() => stored(page, name)).toEqual(SEEDED);
});
