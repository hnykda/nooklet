/**
 * B-192: the block being edited is rewritten from elsewhere — another device, an agent's
 * `block.update`, this app's own "Turn into page" (a server op). Before the fix the editor kept
 * the old text and the next keystroke wrote it back over the rewrite.
 *
 * The owner's rule: with no unsaved typing the editor takes the other text (caret kept where it
 * makes sense); with unsaved typing the local text stays and the row says "This block changed
 * elsewhere", with a button that takes the other version.
 *
 * "Unsaved typing" means keystrokes still inside the editor's 500 ms write debounce. The tests
 * that need it keep typing (`typeWhile`) until the other write has arrived, so they do not depend
 * on the other write landing inside one debounce window.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  clickRow,
  editor,
  editorText,
  MOD,
  openEditing,
  pagePath,
  readBlocks,
} from "../helpers/index.js";

const notice = (page: Page) => page.locator(".vr-remote-notice");

/** Page names seed once per server (`seedPage` is `if_exists: "return"`), so a `--repeat-each` run
 * needs its own for every repeat. */
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

/**
 * Type `ch` every ~60 ms — well inside the 500 ms write debounce, so what is typed stays unsaved —
 * until `done()` holds. Returns what was typed. Checks before each keystroke, so a condition that
 * already holds types nothing more.
 */
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

/** A second device: its own browser context, so its own replica, device id and clock. */
async function secondDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  return { context, page: await context.newPage() };
}

test.describe("an agent's block.update on the block being edited", () => {
  test("with nothing typed, the editor takes the new text and the next keystroke builds on it", async ({
    page,
  }) => {
    const name = unique("Remote Rewrite Agent Clean");
    await openEditing(page, name, "- original text\n- other");
    const id = await idOf(page, name, "original text");

    await api(page, "block.update", { id, content: "rewritten by agent" });

    await expect.poll(() => editorText(page), { timeout: 15_000 }).toBe("rewritten by agent");
    await expect(editor(page)).toBeFocused();
    await expect(notice(page)).toHaveCount(0);
    // The caret was at the end, and stays at the end of the new text.
    expect((await caret(page)).head).toBe("rewritten by agent".length);

    await page.keyboard.type(" more");
    await expect
      .poll(() => storedText(page, name), { timeout: 15_000 })
      .toBe("rewritten by agent more");
  });

  test("an edit before the caret moves the caret with the text after it", async ({ page }) => {
    const name = unique("Remote Rewrite Agent Caret");
    await openEditing(page, name, "- alpha beta gamma");
    const id = await idOf(page, name, "alpha beta gamma");
    await page.keyboard.press("Home");
    for (let i = 0; i < "alpha beta".length; i++) await page.keyboard.press("ArrowRight");
    expect((await caret(page)).head).toBe(10);

    await api(page, "block.update", { id, old_str: "alpha", new_str: "ALPHA-ONE" });

    await expect.poll(() => editorText(page), { timeout: 15_000 }).toBe("ALPHA-ONE beta gamma");
    await page.keyboard.type("!");
    await expect
      .poll(() => storedText(page, name), { timeout: 15_000 })
      .toBe("ALPHA-ONE beta! gamma");
  });

  test("with unsaved typing, the typing stays, the row says so, and the other version can be taken", async ({
    page,
  }) => {
    const name = unique("Remote Rewrite Agent Dirty");
    await openEditing(page, name, "- mine\n- other");
    const id = await idOf(page, name, "mine");

    await page.keyboard.type(" typed");
    const write = api(page, "block.update", { id, content: "theirs" });
    const typed = await typeWhile(page, async () => (await notice(page).count()) > 0);
    await write;

    await expect(notice(page)).toContainText("This block changed elsewhere");
    expect(await editorText(page)).toBe(`mine typed${typed}`);

    await notice(page).getByRole("button", { name: "Use the other version" }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect.poll(() => editorText(page)).toBe("theirs");
    await expect(editor(page)).toBeFocused();
    await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("theirs");

    // Taking it is one undo step, and its undo brings the typing back; redo takes it again.
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => editorText(page)).toBe(`mine typed${typed}`);
    await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe(`mine typed${typed}`);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(() => editorText(page)).toBe("theirs");

    // And the editor is live on the taken text.
    await page.keyboard.press("End");
    await page.keyboard.type(" too");
    await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe("theirs too");
  });

  test("with unsaved typing, the notice goes when editing moves on, and the typing is written", async ({
    page,
  }) => {
    const name = unique("Remote Rewrite Agent Leave");
    const outliner = await openEditing(page, name, "- mine\n- other");
    const id = await idOf(page, name, "mine");

    await page.keyboard.type(" typed");
    const write = api(page, "block.update", { id, content: "theirs" });
    const typed = await typeWhile(page, async () => (await notice(page).count()) > 0);
    await write;

    await clickRow(page, outliner, 1);
    await expect(notice(page)).toHaveCount(0);
    await expect.poll(() => storedText(page, name), { timeout: 15_000 }).toBe(`mine typed${typed}`);
    await expect
      .poll(() => outliner.locator(".vr-row").first().textContent())
      .toBe(`mine typed${typed}`);
  });

  test("with unsaved typing, Keep mine writes the typing and the notice stays gone", async ({
    page,
  }) => {
    const name = unique("Remote Rewrite Agent Keep");
    await openEditing(page, name, "- mine\n- other");
    const id = await idOf(page, name, "mine");
    const other = await idOf(page, name, "other");

    await page.keyboard.type(" typed");
    const write = api(page, "block.update", { id, content: "theirs" });
    const typed = await typeWhile(page, async () => (await notice(page).count()) > 0);
    // No pause from here to the next typing: the version must be dismissed while still unsaved.
    await notice(page).getByRole("button", { name: "Keep mine" }).click();

    // Still typing, a write to another block refetches the page — which still holds "theirs" for
    // this block, as nothing typed has been written yet. The dismissed version is not offered again.
    const otherWrite = api(page, "block.update", { id: other, content: "other changed" });
    const more = await typeWhile(
      page,
      async () => (await page.locator(".vr-row").nth(1).textContent()) === "other changed",
      "y",
    );
    const serverMeanwhile = await storedText(page, name);
    await Promise.all([write, otherWrite]);
    await expect(notice(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    expect(await editorText(page)).toBe(`mine typed${typed}${more}`);
    // Otherwise the typing was written in a gap between keystrokes, and the refetch above compared
    // against that write instead of against the dismissed version: this test proved nothing.
    expect(serverMeanwhile, "the typing stayed unsaved through the refetch").toBe("theirs");

    await expect
      .poll(async () => (await readBlocks(page, name)).map((b) => b.content), { timeout: 15_000 })
      .toEqual([`mine typed${typed}${more}`, "other changed"]);
    await expect(notice(page)).toHaveCount(0);
  });
});

// The other half of the rule: this tab's OWN writes are never a change from elsewhere. Tab writes
// the typed text (a flush before the structural op) and typing carries straight on, so the refetch
// that brings the flushed text back arrives while newer typing is unsaved — the case a comparison
// that forgot this tab's writes would offer back as "changed elsewhere", or take over the typing.
test("typing straight on after Tab is never offered back as a change from elsewhere", async ({
  page,
}) => {
  const name = unique("Remote Rewrite Own Writes");
  const outliner = await openEditing(page, name, "- parent\n- child");
  await page.evaluate(() => {
    const w = window as unknown as { __noticeSeen?: boolean };
    w.__noticeSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".vr-remote-notice")) w.__noticeSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");

  let expected = "child";
  for (let round = 0; round < 4; round++) {
    await page.keyboard.type(` r${round}`);
    await page.keyboard.press(round % 2 === 0 ? "Tab" : "Shift+Tab");
    const deadline = Date.now() + 700;
    let typed = "";
    while (Date.now() < deadline) {
      await page.keyboard.type("z");
      typed += "z";
      await page.waitForTimeout(40);
    }
    expected += ` r${round}${typed}`;
  }

  await expect.poll(() => storedText(page, name, 1), { timeout: 15_000 }).toBe(expected);
  expect(await editorText(page)).toBe(expected);
  expect(await page.evaluate(() => (window as { __noticeSeen?: boolean }).__noticeSeen)).toBe(
    false,
  );
});

test.describe("another device rewrites the block being edited", () => {
  test("with nothing typed, the editor follows the other device's text", async ({
    page,
    browser,
  }) => {
    const name = unique("Remote Rewrite Device Clean");
    await openEditing(page, name, "- shared start\n- other");

    const b = await secondDevice(browser);
    try {
      await b.page.goto(pagePath(name));
      const outlinerB = b.page.locator(".vr-outliner").first();
      await expect(outlinerB.locator(".vr-row").first()).toBeVisible();
      await clickRow(b.page, outlinerB, 0);
      await b.page.keyboard.press("End");
      await b.page.keyboard.type(" from B");
      await b.page.keyboard.press("Escape");

      await expect.poll(() => editorText(page), { timeout: 20_000 }).toBe("shared start from B");
      await expect(editor(page)).toBeFocused();
      await expect(notice(page)).toHaveCount(0);

      await page.keyboard.type("!");
      await expect
        .poll(() => storedText(page, name), { timeout: 15_000 })
        .toBe("shared start from B!");
    } finally {
      await b.context.close();
    }
  });

  test("with unsaved typing, the row offers the other device's version", async ({
    page,
    browser,
  }) => {
    const name = unique("Remote Rewrite Device Dirty");
    await openEditing(page, name, "- shared start\n- other");

    const b = await secondDevice(browser);
    try {
      await b.page.goto(pagePath(name));
      const outlinerB = b.page.locator(".vr-outliner").first();
      await expect(outlinerB.locator(".vr-row").first()).toBeVisible();

      await page.bringToFront();
      await page.keyboard.type(" A");
      // B edits and leaves the block (Escape flushes its write) while A keeps typing.
      const bWrites = (async () => {
        await clickRow(b.page, outlinerB, 0);
        await b.page.keyboard.press("End");
        await b.page.keyboard.type(" from B");
        await b.page.keyboard.press("Escape");
      })();
      const typed = await typeWhile(page, async () => (await notice(page).count()) > 0);
      await bWrites;

      expect(await editorText(page)).toBe(`shared start A${typed}`);
      await notice(page).getByRole("button", { name: "Use the other version" }).click();
      await expect.poll(() => editorText(page)).toBe("shared start from B");
      await expect
        .poll(() => storedText(page, name), { timeout: 15_000 })
        .toBe("shared start from B");
      // Both devices converge on it.
      await expect
        .poll(() => b.page.locator(".vr-row").first().textContent(), { timeout: 20_000 })
        .toBe("shared start from B");
    } finally {
      await b.context.close();
    }
  });
});

test("Turn into page on the row being edited: the editor shows the link, typing continues after it", async ({
  page,
}) => {
  const name = unique("Remote Rewrite Turn");
  const title = unique("Probe start");
  const outliner = await openEditing(page, name, `- ${title}\n  - child\n- other`);
  // Inside the write debounce: the op must still see this text.
  await page.keyboard.type(" kickoff");

  await outliner.locator(".vr-row").first().click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await menu.locator(".ctx-item", { hasText: "Turn into page" }).first().click();
  await expect(menu).toHaveCount(0);

  await expect.poll(() => editorText(page), { timeout: 15_000 }).toBe(`[[${title} kickoff]]`);
  await expect(editor(page)).toBeFocused();
  await expect(notice(page)).toHaveCount(0);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await page.keyboard.type(" typed");
  await expect
    .poll(() => storedText(page, name), { timeout: 15_000 })
    .toBe(`[[${title} kickoff]] typed`);
  expect((await readBlocks(page, `${title} kickoff`)).map((b) => b.content)).toEqual(["child"]);
});
