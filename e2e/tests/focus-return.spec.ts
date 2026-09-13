/**
 * Overlays that take the keyboard — the command palette, the "Move to page…" picker — give it back
 * to whatever had it when they close, in the same keystroke (B-161, B-195), and nothing left over
 * from entering edit mode takes it from them while they are open (B-290).
 *
 * Focus is read synchronously after each key (`expectEditorFocusedNow`), never with the retrying
 * `toBeFocused()`: B-161's test used the retrying form and passed whenever a stale frame-later
 * refocus happened to land in its 10 s. Where the bug lived in frame timing, the frames are made
 * late on purpose (`delayAnimationFrames`) so the test does not depend on how loaded the machine
 * is. Page names start with "Focus Return" — a namespace no other spec uses.
 */

import { expect, test } from "@playwright/test";
import {
  activeElement,
  delayAnimationFrames,
  expectEditorFocusedNow,
  MOD,
  openEditing,
  pagePath,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

/** Long enough that a delayed frame cannot land between one key and the focus check after it. */
const LATE_FRAMES_MS = 400;

function runName(base: string, info: { repeatEachIndex: number; retry: number }): string {
  return `Focus Return ${base} ${info.repeatEachIndex}-${info.retry}`;
}

test("Escape out of the palette gives the editor focus back in the same keystroke, even with frames arriving late", async ({
  page,
}, info) => {
  await delayAnimationFrames(page, LATE_FRAMES_MS);
  const name = runName("Palette Escape", info);
  await openEditing(page, name, "- keep typing");
  // Let the late frame armed by the click that entered editing go by first, so what gives focus
  // back below can only be the palette closing.
  await page.waitForTimeout(LATE_FRAMES_MS + 100);
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  await expectEditorFocusedNow(page, "straight after Escape closed the palette");
  await page.keyboard.type("!");
  await expect.poll(async () => (await readBlocks(page, name))[0]?.content).toBe("keep typing!");
});

test("Cmd/Ctrl+K pressed again to close the palette also gives the editor focus back", async ({
  page,
}, info) => {
  const name = runName("Palette Toggle", info);
  await openEditing(page, name, "- toggled");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  await expectEditorFocusedNow(page, "straight after Cmd/Ctrl+K closed the palette");
  await page.keyboard.type("?");
  await expect.poll(async () => (await readBlocks(page, name))[0]?.content).toBe("toggled?");
});

test("a click into a block then Cmd/Ctrl+K before the next frame: what is typed goes to the palette", async ({
  page,
}, info) => {
  await delayAnimationFrames(page, LATE_FRAMES_MS);
  const name = runName("Late Frame", info);
  await seedPage(page, name, "- untouched");
  await page.goto(pagePath(name));
  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  // The click armed `surface.attach`'s frame-later refocus; with frames late it has not run yet.
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.waitForTimeout(LATE_FRAMES_MS + 200); // ...and now it has
  const active = await activeElement(page);
  expect(active, "the open palette's input should still have focus").toContain("cmd-input");
  await page.keyboard.type("zz");
  await expect(page.locator(".cmd-palette .cmd-input")).toHaveValue("zz");
  await page.keyboard.press("Escape");
  await expectEditorFocusedNow(page, "after Escape");
  expect((await readBlocks(page, name))[0]?.content).toBe("untouched");
});

test("the palette opened from block selection gives the outliner its keys back", async ({
  page,
}, info) => {
  const name = runName("Selection", info);
  const outliner = await openEditing(page, name, "- first\n- second");
  await page.keyboard.press("Escape"); // editing -> block selection, the outliner holds focus
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  expect(await activeElement(page)).toContain("vr-outliner");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  expect(await activeElement(page)).toContain("vr-outliner");
  // And the selection's keys work again: Shift+Down extends it to the second block.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);
});

test("Move to page… onto the block's own page while editing it leaves the editor focused and typeable", async ({
  page,
}, info) => {
  const name = runName("Move Own Page", info);
  const outliner = await openEditing(page, name, "- first\n- second");
  await outliner.locator(".vr-row").first().click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.locator(".ctx-menu .ctx-item", { hasText: "Move to page…" }).click();
  const picker = page.locator(".page-picker");
  await expect(picker.locator(".cmd-input")).toBeFocused();
  await picker.locator(".cmd-input").fill(name);
  await expect(picker.locator(".cmd-row--active")).toHaveText(name);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expectEditorFocusedNow(page, "straight after the picker closed");
  // The block goes to the end of its own page (the server op, then a pull), and its row with it.
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["second", "first"]);
  await expect
    .poll(() => outliner.locator(".vr-row").last().locator(".cm-content").count())
    .toBe(1);
  await expectEditorFocusedNow(page, "after the row moved to the end");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["second", "first!"]);
});

test("Move to page… run from the palette hands focus through the palette and the picker back to the editor", async ({
  page,
}, info) => {
  const name = runName("Move Via Palette", info);
  const outliner = await openEditing(page, name, "- alpha\n- beta");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.type(">Move to page");
  await expect(page.locator(".cmd-palette .cmd-row--active")).toContainText("Move to page");
  await page.keyboard.press("Enter");
  const picker = page.locator(".page-picker");
  await expect(picker.locator(".cmd-input")).toBeFocused();
  await expect(page.locator(".cmd-palette:not(.page-picker)")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expectEditorFocusedNow(page, "straight after Escape closed the picker");
  await page.keyboard.type("!");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["alpha!", "beta"]);
  expect(await outliner.locator(".vr-row").count()).toBe(2);
});

test("pressing on a context-menu separator or on the menu's padding keeps the block in edit mode", async ({
  page,
}, info) => {
  const name = runName("Menu Separator", info);
  const outliner = await openEditing(page, name, "- first\n- second");
  await outliner.locator(".vr-row").nth(1).click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expectEditorFocusedNow(page, "with the menu open");

  await menu.locator(".ctx-sep").first().click();
  await expect(menu).toBeVisible(); // a press inside the menu is not a dismissal
  await expectEditorFocusedNow(page, "after a press on a separator");
  await menu.click({ position: { x: 2, y: 2 } }); // inside the border, outside every item
  await expectEditorFocusedNow(page, "after a press on the menu's padding");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expectEditorFocusedNow(page, "after Escape closed the menu");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first", "second!"]);
});

test("choosing a page in the palette while editing: what is typed before it shows never lands in the block being left", async ({
  page,
}, info) => {
  // B-293. The palette gives focus back as it closes (B-161), but a page row and "Create page"
  // leave the page only after a replica read or a write — focus given back to the editor here
  // put the next keys into a block on a page that was no longer on screen.
  const from = runName("Leave Page", info);
  const target = runName("Leave Page Target", info);
  const created = runName("Leave Page Created", info);
  await seedPage(page, target, "- over there");

  for (const [label, pick] of [
    ["page row", target],
    ["create row", created],
  ] as const) {
    await openEditing(page, from, "- origin");
    await page.keyboard.press(`${MOD}+k`);
    await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
    await page.keyboard.type(pick);
    const wanted =
      label === "page row"
        ? page.locator(".cmd-palette .cmd-row", { hasText: pick }).first()
        : page.locator(".cmd-palette .cmd-row", { hasText: "Create page" });
    await expect(wanted).toBeVisible();
    // Walk the highlight to the row wanted (the create row is last).
    for (let i = 0; i < 20; i++) {
      if (
        (await page.locator(".cmd-palette .cmd-row--active").textContent())?.includes(
          label === "page row" ? pick : "Create page",
        )
      )
        break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    // Straight after Enter, before the new page can have rendered: the editor on the page being
    // left must not hold the keyboard.
    const active = await activeElement(page);
    expect(active, `${label}: focus straight after Enter`).not.toContain("cm-content");
    await page.keyboard.type("qq");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(pick), "i"));
    await page.waitForTimeout(700); // past the 500 ms edit flush, had anything been typed
    expect(
      (await readBlocks(page, from)).map((b) => b.content),
      label,
    ).toEqual(["origin"]);
  }
});

test("following a link from the palette while editing: what is typed before the page shows never lands in the block being left", async ({
  page,
}, info) => {
  // B-293, the command-row form: "Follow link under cursor" resolves the link before it navigates.
  const target = runName("Follow Target", info);
  const from = runName("Follow From", info);
  await seedPage(page, target, "- over there");
  await openEditing(page, from, `- go [[${target}]]`);
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
  await page.keyboard.type(">Follow link under cursor");
  await expect(page.locator(".cmd-palette .cmd-row--active")).toContainText(
    "Follow link under cursor",
  );
  await page.keyboard.press("Enter");
  expect(await activeElement(page), "focus straight after Enter").not.toContain("cm-content");
  await page.keyboard.type("qq");
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(target), "i")); // routed by the lowercased name
  await page.waitForTimeout(700);
  expect((await readBlocks(page, from)).map((b) => b.content)).toEqual([`go [[${target}]]`]);
});

test("the caret comes back where it was, mid-block, through the palette and the Move to page picker", async ({
  page,
}, info) => {
  // B-296: focus came back with the DOM caret at the start of the block. A key with a keydown made
  // CodeMirror put its own caret back first, but text with no keydown (an IME commit, dictation,
  // the emoji picker; `insertText` here) arriving straight after landed at the start: every round.
  const name = runName("Caret Mid Block", info);
  await openEditing(page, name, "- abcdefghij\n- other");
  const toOffsetTwo = async (): Promise<void> => {
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
  };
  let expected = "abcdefghij";
  for (const mark of ["č", "ř"]) {
    await toOffsetTwo();
    await page.keyboard.press(`${MOD}+k`);
    await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expectEditorFocusedNow(page, `after Escape (${mark})`);
    await page.keyboard.insertText(mark);
    expected = `ab${mark}${expected.slice(2)}`;
  }
  await toOffsetTwo();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(">Move to page");
  await expect(page.locator(".cmd-palette .cmd-row--active")).toContainText("Move to page");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-picker .cmd-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectEditorFocusedNow(page, "after Escape out of the picker");
  await page.keyboard.insertText("ž");
  expected = `abž${expected.slice(2)}`;
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual([expected, "other"]);
});
