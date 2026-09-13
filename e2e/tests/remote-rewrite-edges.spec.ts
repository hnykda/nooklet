/**
 * B-192, verification pass: the edges around a rewrite from elsewhere of the block being edited
 * that `remote-rewrite.spec.ts` does not reach — a clock behind on the take path, a write elsewhere
 * that leaves the text as it was (an agent flipping the task marker), undo while the notice stands,
 * a second tab of the same browser, and Czech text on a namespaced page.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  editor,
  editorText,
  MOD,
  openEditing,
  openPage,
  pagePath,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

const notice = (page: Page) => page.locator(".vr-remote-notice");

function unique(name: string): string {
  const repeat = test.info().repeatEachIndex;
  return repeat === 0 ? name : `${name} ${repeat}`;
}

async function idOf(page: Page, pageName: string, content: string): Promise<string> {
  const block = (await readBlocks(page, pageName)).find((b) => b.content === content);
  if (!block) throw new Error(`no block "${content}" on ${pageName}`);
  return block.id;
}

async function storedText(page: Page, pageName: string, index = 0): Promise<string | undefined> {
  return (await readBlocks(page, pageName))[index]?.content;
}

async function typeWhile(page: Page, done: () => Promise<boolean>, ch = "x"): Promise<string> {
  let typed = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await done()) return typed;
    await page.keyboard.type(ch);
    typed += ch;
    await page.waitForTimeout(60);
  }
  throw new Error(`typed ${typed.length} characters and the condition never held`);
}

test("with nothing typed and this tab's clock behind, typing on the taken text is saved", async ({
  page,
}) => {
  // The editor's clock only follows wall time. A rewrite stamped by a clock ahead of it, once taken
  // into the editor, must not make every keystroke on it lose last-writer-wins.
  await page.clock.setFixedTime(Date.now() - 20_000);
  const name = unique("Remote Edge Skew Take");
  await openEditing(page, name, "- original\n- other");
  const id = await idOf(page, name, "original");

  await api(page, "block.update", { id, content: "rewritten" });
  await expect.poll(() => editorText(page), { timeout: 15_000 }).toBe("rewritten");

  await page.keyboard.type(" more");
  await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("rewritten more");
});

test("an agent marking the task DONE while you type does not offer the old text back", async ({
  page,
}) => {
  // `block.update` with old_str/new_str writes a `block.text` even when only the marker moved, so
  // the block's `content_hlc` is newer while its text is the text the typing started from.
  const name = unique("Remote Edge Marker");
  await openEditing(page, name, "- TODO call the plumber\n- other");
  const id = await idOf(page, name, "call the plumber");
  expect(await editorText(page)).toBe("call the plumber");

  await page.keyboard.type(" today");
  const write = api(page, "block.update", { id, old_str: "TODO", new_str: "DONE" });
  // Keep typing well past the refetch that brings the marker (the pill changes on the row).
  const typed = await typeWhile(
    page,
    async () => (await page.locator(".vr-row").first().locator(".vr-marker-DONE").count()) > 0,
  );
  await write;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.type("y");
    await page.waitForTimeout(60);
  }
  await expect(notice(page)).toHaveCount(0);
  await expect
    .poll(() => storedText(page, name), { timeout: 15_000 })
    .toBe(`call the plumber today${typed}yyyyy`);
});

test("undo while the notice stands takes back the typing, and the other version can still be taken", async ({
  page,
}) => {
  const name = unique("Remote Edge Undo Notice");
  await openEditing(page, name, "- mine\n- other");
  const id = await idOf(page, name, "mine");

  await page.keyboard.type(" typed");
  const write = api(page, "block.update", { id, content: "theirs" });
  await typeWhile(page, async () => (await notice(page).count()) > 0);
  await write;

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorText(page)).toBe("mine");
  await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("mine");
  await expect(editor(page)).toBeFocused();

  if ((await notice(page).count()) > 0) {
    await notice(page).getByRole("button", { name: "Use the other version" }).click();
    await expect.poll(() => editorText(page)).toBe("theirs");
    await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("theirs");
  }
});

test("a second tab of the same browser rewriting the block is followed", async ({
  page,
  context,
}) => {
  const name = unique("Remote Edge Same Browser");
  await openEditing(page, name, "- shared\n- other");

  const second = await context.newPage();
  try {
    await second.goto(pagePath(name));
    const outliner = second.locator(".vr-outliner").first();
    await expect(outliner.locator(".vr-row").first()).toBeVisible();
    await outliner.locator(".vr-block-view").first().click();
    await second.keyboard.press("End");
    await second.keyboard.type(" from tab two");
    await second.keyboard.press("Escape");

    await page.bringToFront();
    await expect.poll(() => editorText(page), { timeout: 20_000 }).toBe("shared from tab two");
    await expect(notice(page)).toHaveCount(0);
    await page.keyboard.type("!");
    await expect
      .poll(() => storedText(page, name), { timeout: 15_000 })
      .toBe("shared from tab two!");
  } finally {
    await second.close();
  }
});

test("Czech text on a namespaced page: the caret stays put through a rewrite before it", async ({
  page,
}) => {
  const name = unique("Projekty/Příliš žluťoučký kůň");
  await openEditing(page, name, "- Úkol: zavolat instalatérovi zítra\n- další");
  const id = await idOf(page, name, "Úkol: zavolat instalatérovi zítra");
  await page.keyboard.press("Home");
  const upTo = "Úkol: zavolat instalatérovi".length;
  for (let i = 0; i < upTo; i++) await page.keyboard.press("ArrowRight");
  expect((await caret(page)).head).toBe(upTo);

  await api(page, "block.update", { id, old_str: "Úkol", new_str: "Důležitý úkol" });
  await expect
    .poll(() => editorText(page), { timeout: 15_000 })
    .toBe("Důležitý úkol: zavolat instalatérovi zítra");
  await page.keyboard.type(" ještě dnes");
  await expect
    .poll(() => storedText(page, name), { timeout: 15_000 })
    .toBe("Důležitý úkol: zavolat instalatérovi ještě dnes zítra");
});

test("a block with a property line: a text rewrite keeps the property line and the caret on line 1", async ({
  page,
}) => {
  const name = unique("Remote Edge Props");
  await openEditing(page, name, "- first line\n  owner:: alice\n- other");
  const id = await idOf(page, name, "first line");
  await expect.poll(() => editorText(page)).toBe("first line\nowner:: alice");
  expect((await caret(page)).head).toBe("first line".length);

  await api(page, "block.update", { id, content: "rewritten line\nowner:: alice" });
  await expect
    .poll(() => editorText(page), { timeout: 15_000 })
    .toBe("rewritten line\nowner:: alice");
  await expect(notice(page)).toHaveCount(0);
  await page.keyboard.type("!");
  const first = async () =>
    (
      await api<{ tree?: Array<{ content: string; properties?: Record<string, string> }> }>(
        page,
        "page.read",
        { page: name, format: "json" },
      )
    ).tree?.[0];
  await expect
    .poll(async () => (await first())?.content, { timeout: 15_000 })
    .toBe("rewritten line!");
  expect((await first())?.properties?.owner).toBe("alice");
});

test("with this tab's clock behind, typing into a block the row showed rewritten elsewhere is saved", async ({
  page,
}) => {
  // Not the editor's block when the write lands: the row shows it, then the person clicks in.
  await page.clock.setFixedTime(Date.now() - 20_000);
  const name = unique("Remote Edge Skew Click");
  const outliner = await openPage(page, name, "- original\n- other");
  const id = await idOf(page, name, "original");
  await api(page, "block.update", { id, content: "rewritten" });
  await expect
    .poll(() => outliner.locator(".vr-row").first().textContent(), { timeout: 15_000 })
    .toBe("rewritten");

  await outliner.locator(".vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("rewritten more");
});

test("a rewrite while the [[ popup is open does not garble the pick", async ({ page }) => {
  // The popup keeps the trigger's offset and re-detects only on keyup/pointerup; a rewrite taken
  // into the buffer under it made Enter replace the wrong range (B-463).
  // The repeat index inside the name, not appended: a query for one repeat's target must not also
  // match the previous repeat's.
  const target = `Remote Edge Popup R${test.info().repeatEachIndex} Target`;
  await seedPage(page, target, "- x");
  const name = unique("Remote Edge Popup");
  await openEditing(page, name, "- alpha\n- other");
  const id = await idOf(page, name, "alpha");
  const query = target.slice(0, -"rget".length);
  await page.keyboard.type(` see [[${query}`, { delay: 30 });
  await expect(page.locator(".cmd-popup").first()).toBeVisible();
  // Past the write debounce: nothing unsaved in the buffer, only the open popup.
  await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe(`alpha see [[${query}`);

  await api(page, "block.update", { id, old_str: "alpha", new_str: "ALPHA BETA" });
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cmd-popup").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => editorText(page)).toBe(`alpha see [[${target}]]`);
  await expect
    .poll(() => storedText(page, name), { timeout: 15_000 })
    .toBe(`alpha see [[${target}]]`);

  // And the other version is still there to take, whole.
  await notice(page).getByRole("button", { name: "Use the other version" }).click();
  await expect.poll(() => editorText(page)).toBe(`ALPHA BETA see [[${query}`);
  await expect
    .poll(() => storedText(page, name), { timeout: 15_000 })
    .toBe(`ALPHA BETA see [[${query}`);
});
