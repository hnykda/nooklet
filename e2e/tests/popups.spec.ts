/**
 * The four popups that open while typing — `[[`, `#`, `((` and `/` — against the rules in
 * docs/spec/commands-and-keymap.md §F/§G (R53–R59): open on the trigger, filter as you type,
 * Up/Down move the highlight, Enter/Tab select and insert the right text with the caret after it,
 * Escape closes and leaves the text alone, and the editor keeps focus through all of it.
 *
 * Every popup is one `.cmd-popup` with `role="option"` rows and `aria-selected` on the highlight;
 * `.cmd-row--active` is the highlighted row. Each test seeds pages with a prefix unique to itself
 * so the ranking it asserts on is not disturbed by pages other specs made.
 *
 * Seeds never end in a space: the server trims a block's trailing whitespace, so a test that
 * needs a space before its trigger types the space itself.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  clickAway,
  clickRow,
  editor,
  editorText,
  expectEditorFocusedNow,
  openEditing,
  readBlocks,
  seedPage,
  typeWatchingFocus,
} from "../helpers/index.js";

function popup(page: Page): Locator {
  return page.locator(".cmd-popup");
}

function activeRow(page: Page): Locator {
  return popup(page).locator(".cmd-row--active");
}

function rowsOf(page: Page): Locator {
  return popup(page).locator('[role="option"]');
}

// ── [[ page references ──────────────────────────────────────────────────────────────────────────

test.describe("[[ page autocomplete", () => {
  test("opens on the second [ with date shortcuts first while the query is empty", async ({
    page,
  }) => {
    await openEditing(page, "Popup Wiki Open", "- see");
    await page.keyboard.type(" [");
    await expect(popup(page)).toHaveCount(0);
    await page.keyboard.type("[");
    await expect(popup(page)).toBeVisible();
    // R56 + `autocomplete/dates.ts`: Today, Tomorrow, Yesterday… before any page.
    await expect(rowsOf(page).nth(0)).toContainText("Today");
    await expect(rowsOf(page).nth(1)).toContainText("Tomorrow");
    await expect(rowsOf(page).nth(2)).toContainText("Yesterday");
    await expect(activeRow(page)).toContainText("Today");
  });

  test("filters as you type and offers to create when nothing matches exactly", async ({
    page,
  }) => {
    await seedPage(page, "Popup Wiki Apple", "- a");
    await seedPage(page, "Popup Wiki Apricot", "- b");
    await openEditing(page, "Popup Wiki Filter", "- x");
    await page.keyboard.type(" [[Popup Wiki Ap");
    await expect(popup(page)).toBeVisible();
    await expect(rowsOf(page).filter({ hasText: "Popup Wiki Apple" })).toHaveCount(1);
    await expect(rowsOf(page).filter({ hasText: "Popup Wiki Apricot" })).toHaveCount(1);
    await expect(rowsOf(page).filter({ hasText: "Today" })).toHaveCount(0);
    await expect(rowsOf(page).filter({ hasText: 'New page "Popup Wiki Ap"' })).toHaveCount(1);

    await page.keyboard.type("ple");
    await expect(rowsOf(page).filter({ hasText: "Popup Wiki Apricot" })).toHaveCount(0);
    // An exact (case-insensitive) match means no "New page" row (R56).
    await expect(rowsOf(page).filter({ hasText: "New page" })).toHaveCount(0);
  });

  test("ArrowDown and ArrowUp move the highlight without moving the caret or losing focus", async ({
    page,
  }) => {
    await openEditing(page, "Popup Wiki Arrows", "- x");
    await page.keyboard.type(" [[");
    await expect(popup(page)).toBeVisible();
    const before = await caret(page);

    await page.keyboard.press("ArrowDown");
    await expect(activeRow(page)).toContainText("Tomorrow");
    await page.keyboard.press("ArrowDown");
    await expect(activeRow(page)).toContainText("Yesterday");
    await page.keyboard.press("ArrowUp");
    await expect(activeRow(page)).toContainText("Tomorrow");
    // Clamped at the top, no wraparound (R59).
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(activeRow(page)).toContainText("Today");

    await expectEditorFocusedNow(page, "after arrowing through the popup");
    expect(await caret(page)).toEqual(before);
    expect(await editorText(page)).toBe("x [[");
  });

  test("Enter inserts the highlighted page as [[Title]] with the caret after ]]", async ({
    page,
  }) => {
    await seedPage(page, "Popup Wiki Target", "- t");
    await openEditing(page, "Popup Wiki Enter", "- link");
    await page.keyboard.type(" [[Popup Wiki Targ");
    await expect(activeRow(page)).toContainText("Popup Wiki Target");
    await page.keyboard.press("Enter");

    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("link [[Popup Wiki Target]]");
    expect(await caret(page)).toEqual({ anchor: 26, head: 26 });
    await expectEditorFocusedNow(page, "after accepting with Enter");
    // Still exactly one block: Enter selected, it did not split (R12 step 2).
    await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);
    await page.keyboard.type(" after");
    // The live preview hides `[[`/`]]` once the caret leaves the link, so read what is stored.
    await expect
      .poll(async () => (await readBlocks(page, "Popup Wiki Enter")).map((b) => b.content))
      .toEqual(["link [[Popup Wiki Target]] after"]);
  });

  test("Tab also accepts the highlighted item (R59)", async ({ page }) => {
    await seedPage(page, "Popup Wiki TabTarget", "- t");
    await openEditing(page, "Popup Wiki Tab", "- x");
    await page.keyboard.type(" [[Popup Wiki TabTar");
    await expect(activeRow(page)).toContainText("Popup Wiki TabTarget");
    await page.keyboard.press("Tab");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x [[Popup Wiki TabTarget]]");
    // Tab selected; it did not indent the block.
    const depth = await page
      .locator(".vr-outliner .vr-row")
      .first()
      .evaluate((r) => (r as HTMLElement).style.getPropertyValue("--depth").trim());
    expect(depth).toBe("0");
  });

  test("clicking a row inserts [[Title]] with the caret after it", async ({ page }) => {
    await seedPage(page, "Popup Wiki ClickTarget", "- t");
    await openEditing(page, "Popup Wiki Click", "- x");
    await page.keyboard.type(" [[Popup Wiki ClickTar");
    await rowsOf(page).filter({ hasText: "Popup Wiki ClickTarget" }).first().click();
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x [[Popup Wiki ClickTarget]]");
  });

  test("clicking a row leaves the editor focused", async ({ page }) => {
    await seedPage(page, "Popup Wiki FocusTarget", "- t");
    await openEditing(page, "Popup Wiki ClickFocus", "- x");
    await page.keyboard.type(" [[Popup Wiki FocusTar");
    await rowsOf(page).filter({ hasText: "Popup Wiki FocusTarget" }).first().click();
    await expect(popup(page)).toHaveCount(0);
    await expectEditorFocusedNow(page, "after clicking a popup row");
    await page.keyboard.type("!");
    // The live preview hides `[[`/`]]` once the caret is past the link, so read what is stored.
    await expect
      .poll(async () => (await readBlocks(page, "Popup Wiki ClickFocus")).map((b) => b.content))
      .toEqual(["x [[Popup Wiki FocusTarget]]!"]);
  });

  test("Escape closes the popup, keeps the typed text and keeps the editor focused", async ({
    page,
  }) => {
    await openEditing(page, "Popup Wiki Escape", "- x");
    await page.keyboard.type(" [[quer");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x [[quer");
    await expectEditorFocusedNow(page, "after Escape closed the popup");
    // Escape closed the POPUP — it did not also drop the block into selection mode (R28's
    // `!popupOpen` guard).
    await expect(page.locator(".vr-row-selected")).toHaveCount(0);
    await expect(editor(page)).toHaveCount(1);
  });

  test("typing the closing ] closes the popup", async ({ page }) => {
    await openEditing(page, "Popup Wiki Close Bracket", "- x");
    await page.keyboard.type(" [[abc");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.type("]]");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x [[abc]]");
  });

  test("backspacing through the trigger closes the popup", async ({ page }) => {
    await openEditing(page, "Popup Wiki Backspace", "- x");
    await page.keyboard.type(" [[ab");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(popup(page)).toBeVisible(); // "[[" alone still triggers
    await page.keyboard.press("Backspace");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x [");
  });

  test("clicking elsewhere dismisses the popup", async ({ page }) => {
    await openEditing(page, "Popup Wiki Click Away", "- x");
    await page.keyboard.type(" [[abc");
    await expect(popup(page)).toBeVisible();
    await clickAway(page);
    await expect(popup(page)).toHaveCount(0);
  });

  test("a namespaced query keeps focus on every keystroke and does not open the slash menu", async ({
    page,
  }) => {
    await openEditing(page, "Popup Wiki Namespace", "- x");
    await page.keyboard.type(" [[");
    const losses = await typeWatchingFocus(page, "Popup Wiki Namespace/child");
    expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
    await expect(popup(page)).toHaveCount(1);
    await expect(rowsOf(page).filter({ hasText: "Heading 1" })).toHaveCount(0);
    await expect(
      rowsOf(page).filter({ hasText: 'New page "Popup Wiki Namespace/child"' }),
    ).toHaveCount(1);
  });

  test("the New page row creates the page and links it", async ({ page }) => {
    await openEditing(page, "Popup Wiki Create", "- x");
    await page.keyboard.type(" [[Popup Wiki Created Fresh");
    const create = rowsOf(page).filter({ hasText: 'New page "Popup Wiki Created Fresh"' });
    await expect(create).toHaveCount(1);
    await create.click();
    await expect(editor(page)).toHaveText("x [[Popup Wiki Created Fresh]]");

    // It really exists now, as an ordinary page.
    await expect
      .poll(async () => {
        try {
          const r = await api<{ page: { kind: string } }>(page, "page.read", {
            page: "Popup Wiki Created Fresh",
          });
          return r.page.kind;
        } catch {
          return "missing";
        }
      })
      .toBe("page");
  });

  test("a date shortcut inserts the day in the reader's title format", async ({ page }) => {
    await openEditing(page, "Popup Wiki Date", "- due");
    await page.keyboard.type(" [[");
    const tomorrow = rowsOf(page).filter({ hasText: "Tomorrow" });
    await expect(tomorrow).toHaveCount(1);
    const shown = (await tomorrow.locator(".cmd-row-subtitle").textContent()) ?? "";
    expect(shown).not.toBe("");
    await tomorrow.click();
    await expect(editor(page)).toHaveText(`due [[${shown}]]`);
  });

  test("picking a block from [[ inserts a ((block ref)) instead of a page link", async ({
    page,
  }) => {
    await seedPage(page, "Popup Wiki BlockSrc", "- a very findable thought zebra");
    const [src] = await readBlocks(page, "Popup Wiki BlockSrc");
    const outliner = await openEditing(page, "Popup Wiki BlockPick", "- x\n- other");
    await page.keyboard.type(" [[findable thought zebra");
    const blockRow = rowsOf(page).filter({ hasText: "a very findable thought zebra" });
    await expect(blockRow).toHaveCount(1);
    await expect(blockRow.locator(".cmd-row-subtitle")).toHaveText("Popup Wiki BlockSrc");
    await blockRow.click();
    await expect(editor(page)).toHaveText(`x ((${src?.id}))`);
    // Rendered as the referenced text, not an opaque id.
    await clickRow(page, outliner, 1);
    await expect(outliner.locator(".vr-row").nth(0).locator(".vr-block-ref")).toContainText(
      "a very findable thought",
    );
  });
});

// ── # tags ───────────────────────────────────────────────────────────────────────────────────────

test.describe("# tag autocomplete", () => {
  test("opens at the start of a run, not mid-word (R57)", async ({ page }) => {
    await openEditing(page, "Popup Tag Trigger", "- word");
    await page.keyboard.type("#x");
    await expect(popup(page)).toHaveCount(0);
    await page.keyboard.type(" #y");
    await expect(popup(page)).toBeVisible();
  });

  test("keeps the editor focused while the query is typed", async ({ page }) => {
    await openEditing(page, "Popup Tag Focus", "- x");
    await page.keyboard.type(" #");
    const losses = await typeWatchingFocus(page, "someTagQuery");
    expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
    await expect(popup(page)).toBeVisible();
  });

  test("a space closes it", async ({ page }) => {
    await openEditing(page, "Popup Tag Space", "- x");
    await page.keyboard.type(" #abc");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.type(" ");
    await expect(popup(page)).toHaveCount(0);
  });

  test("Escape closes it and leaves #query in place", async ({ page }) => {
    await openEditing(page, "Popup Tag Escape", "- x");
    await page.keyboard.type(" #abc");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x #abc");
    await expectEditorFocusedNow(page, "after Escape on the tag popup");
  });

  test("New page from # creates the page and inserts #Name with no closer", async ({ page }) => {
    await openEditing(page, "Popup Tag Create", "- x");
    await page.keyboard.type(" #PopupTagFreshOne");
    const create = rowsOf(page).filter({ hasText: 'New page "PopupTagFreshOne"' });
    await expect(create).toHaveCount(1);
    await create.click();
    await expect(editor(page)).toHaveText("x #PopupTagFreshOne");
    await expect
      .poll(async () => {
        try {
          await api(page, "page.read", { page: "PopupTagFreshOne" });
          return "exists";
        } catch {
          return "missing";
        }
      })
      .toBe("exists");
  });

  test("lists a page that is already used as a tag", async ({ page }) => {
    // A page becomes a tag by being referenced as one (PLAN.md: tags are pages).
    await seedPage(page, "PopupTagKnown", "- the tag page");
    await seedPage(page, "Popup Tag Known User", "- tagged #PopupTagKnown");
    await openEditing(page, "Popup Tag List", "- x");
    await page.keyboard.type(" #PopupTagKno");
    await expect(popup(page)).toBeVisible();
    await expect(rowsOf(page).filter({ hasText: "PopupTagKnown" })).toHaveCount(1);
  });
});

// ── (( block references ─────────────────────────────────────────────────────────────────────────

test.describe("(( block autocomplete", () => {
  test("lists matching blocks with their page, and no Create row (R58)", async ({ page }) => {
    await seedPage(page, "Popup Ref Source", "- unique quokka sentence");
    await openEditing(page, "Popup Ref List", "- see");
    await page.keyboard.type(" ((quokka");
    await expect(popup(page)).toBeVisible();
    const row = rowsOf(page).filter({ hasText: "unique quokka sentence" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".cmd-row-subtitle")).toHaveText("Popup Ref Source");
    await expect(rowsOf(page).filter({ hasText: "New page" })).toHaveCount(0);
  });

  test("Enter inserts ((id)) with the caret after it (R58)", async ({ page }) => {
    await seedPage(page, "Popup Ref EnterSrc", "- unique wombat sentence");
    const [src] = await readBlocks(page, "Popup Ref EnterSrc");
    await openEditing(page, "Popup Ref Enter", "- see");
    await page.keyboard.type(" ((wombat");
    await expect(activeRow(page)).toContainText("unique wombat sentence");
    await page.keyboard.press("Enter");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText(`see ((${src?.id}))`);
    expect(await caret(page)).toEqual({ anchor: 22, head: 22 });
    await expectEditorFocusedNow(page, "after inserting a block ref");
  });

  test("clicking a row inserts ((id)) and it renders as the block's text", async ({ page }) => {
    await seedPage(page, "Popup Ref ClickSrc", "- unique numbat sentence");
    const [src] = await readBlocks(page, "Popup Ref ClickSrc");
    const outliner = await openEditing(page, "Popup Ref Click", "- see\n- other");
    await page.keyboard.type(" ((numbat");
    await rowsOf(page).filter({ hasText: "unique numbat sentence" }).click();
    await expect(editor(page)).toHaveText(`see ((${src?.id}))`);
    await clickRow(page, outliner, 1);
    await expect(outliner.locator(".vr-row").nth(0).locator(".vr-block-ref")).toHaveText(
      "unique numbat sentence",
    );
  });

  test("keeps the editor focused while the query is typed", async ({ page }) => {
    await openEditing(page, "Popup Ref Focus", "- x");
    await page.keyboard.type(" ((");
    const losses = await typeWatchingFocus(page, "some words");
    expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
  });

  test("typing ) closes it", async ({ page }) => {
    await openEditing(page, "Popup Ref Close", "- x");
    await page.keyboard.type(" ((ab");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.type(")");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x ((ab)");
  });

  test("Escape closes it leaving the text", async ({ page }) => {
    await openEditing(page, "Popup Ref Escape", "- x");
    await page.keyboard.type(" ((cd");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x ((cd");
  });
});

// ── / slash menu ─────────────────────────────────────────────────────────────────────────────────

const SLASH_ORDER = [
  "TODO / task",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Numbered list",
  "Code block",
  "Table",
  "Image",
  "Scheduled",
  "Deadline",
  "Embed page",
  "Embed block",
  "Page reference",
  "Tag",
  "Today's date",
  "Property",
  // M7 appends, in `items.ts` order: templates (ADR 019) and the query fence (ADR 011).
  "Template",
  "Query",
  // B-608: the rest of both task pairs (this spec's graph has no tasks, so its workflow is `todo`).
  "DOING",
  "LATER",
  "NOW",
  // Contributed by the built-in mermaid plugin's client half, after every core row (ADR 023).
  "Mermaid diagram",
];

test.describe("/ slash menu", () => {
  test("opens at a run start with every item in R54 order, first one highlighted", async ({
    page,
  }) => {
    await openEditing(page, "Popup Slash Open", "- x");
    await page.keyboard.type(" /");
    await expect(popup(page)).toBeVisible();
    await expect(rowsOf(page)).toHaveText(SLASH_ORDER);
    await expect(activeRow(page)).toHaveText("TODO / task");
  });

  test("opens as the first character of an empty block", async ({ page }) => {
    await openEditing(page, "Popup Slash Empty", "- x");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(popup(page)).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(SLASH_ORDER.length);
  });

  test("does not open mid-word (a/b), and a space closes it (R53)", async ({ page }) => {
    await openEditing(page, "Popup Slash Midword", "- a");
    await page.keyboard.type("/b");
    await expect(popup(page)).toHaveCount(0);
    await page.keyboard.type(" /");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.type(" ");
    await expect(popup(page)).toHaveCount(0);
  });

  test("a second / does not open a second menu (R53)", async ({ page }) => {
    await openEditing(page, "Popup Slash Double", "- x");
    await page.keyboard.type(" /");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.type("/");
    const count = await popup(page).count();
    expect(count).toBeLessThanOrEqual(1);
    if (count === 1) {
      await expect(popup(page)).toContainText("No results");
      await expect(rowsOf(page)).toHaveCount(0);
    }
  });

  test("filters by label and by keyword", async ({ page }) => {
    await openEditing(page, "Popup Slash Filter", "- x");
    await page.keyboard.type(" /head");
    await expect(rowsOf(page)).toHaveText(["Heading 1", "Heading 2", "Heading 3"]);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("h2");
    await expect(rowsOf(page).first()).toHaveText("Heading 2");
    for (let i = 0; i < 2; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("wikilink");
    await expect(rowsOf(page).first()).toHaveText("Page reference");
  });

  test("keeps the editor focused while the query is typed", async ({ page }) => {
    await openEditing(page, "Popup Slash Focus", "- x");
    await page.keyboard.type(" /");
    const losses = await typeWatchingFocus(page, "heading");
    expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
  });

  test("ArrowDown then Enter runs the item and removes the trigger text", async ({ page }) => {
    await openEditing(page, "Popup Slash Enter", "- my title");
    await page.keyboard.type(" /");
    await page.keyboard.press("ArrowDown");
    await expect(activeRow(page)).toHaveText("Heading 1");
    await page.keyboard.press("Enter");
    await expect(popup(page)).toHaveCount(0);
    // The live preview hides the `# ` marker unless the caret touches it, so read what is stored.
    await expect
      .poll(async () => (await readBlocks(page, "Popup Slash Enter")).map((b) => b.content))
      .toEqual(["# my title "]);
    await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);
    await expectEditorFocusedNow(page, "after running a slash item");
  });

  test("Tab accepts the highlighted item and does not indent (R55)", async ({ page }) => {
    const outliner = await openEditing(page, "Popup Slash Tab", "- first\n- second");
    await clickRow(page, outliner, 1);
    await page.keyboard.press("End");
    await page.keyboard.type(" /h3");
    await expect(activeRow(page)).toHaveText("Heading 3");
    await page.keyboard.press("Tab");
    await expect
      .poll(async () => (await readBlocks(page, "Popup Slash Tab")).map((b) => b.content))
      .toEqual(["first", "### second "]);
    const depth = await outliner
      .locator(".vr-row")
      .nth(1)
      .evaluate((r) => (r as HTMLElement).style.getPropertyValue("--depth").trim());
    expect(depth).toBe("0");
  });

  test("Escape closes the menu and leaves the / in place", async ({ page }) => {
    await openEditing(page, "Popup Slash Escape", "- x");
    await page.keyboard.type(" /he");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("x /he");
    await expectEditorFocusedNow(page, "after Escape on the slash menu");
    await expect(page.locator(".vr-row-selected")).toHaveCount(0);
  });

  test("backspacing through the / closes the menu", async ({ page }) => {
    await openEditing(page, "Popup Slash Backspace", "- x");
    await page.keyboard.type(" /h");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(popup(page)).toHaveCount(0);
  });

  test("TODO / task turns the block into a task and removes the trigger", async ({ page }) => {
    const outliner = await openEditing(page, "Popup Slash Todo", "- buy milk");
    await page.keyboard.type(" /todo");
    await expect(activeRow(page)).toHaveText("TODO / task");
    await activeRow(page).click();
    await expect(popup(page)).toHaveCount(0);
    await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);
    await expect(editor(page)).toHaveText("buy milk ");
  });

  test("Heading 1 prefixes the block and re-applying a level replaces it (R48)", async ({
    page,
  }) => {
    await openEditing(page, "Popup Slash Heading", "- my title");
    await page.keyboard.type(" /h1");
    await rowsOf(page).filter({ hasText: "Heading 1" }).click();
    // The live preview hides the `# ` marker unless the caret touches it, so read what is stored.
    const stored = async () =>
      (await readBlocks(page, "Popup Slash Heading")).map((b) => b.content);
    // The typed space before `/h1` survives: block text set through the editor is kept verbatim.
    await expect.poll(stored).toEqual(["# my title "]);
    await editor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" /h2");
    await rowsOf(page).filter({ hasText: "Heading 2" }).click();
    await expect.poll(stored).toEqual(["## my title  "]);
    await page.reload();
    await expect(page.locator("h2.vr-heading")).toHaveText("my title");
  });

  test("Code block wraps the content in a fence", async ({ page }) => {
    await openEditing(page, "Popup Slash Code", "- const x = 1");
    await page.keyboard.type(" /code");
    await rowsOf(page).filter({ hasText: "Code block" }).click();
    expect(await editorText(page)).toMatch(/^```/);
    expect(await editorText(page)).toContain("const x = 1");
    await page.reload();
    await expect(page.locator(".vr-fence")).toHaveCount(1);
  });

  test("Table on an empty block inserts a skeleton that renders as a table", async ({ page }) => {
    await openEditing(page, "Popup Slash Table", "- x");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/table");
    await rowsOf(page).filter({ hasText: "Table" }).first().click();
    expect(await editorText(page)).toContain("|");
    await page.reload();
    await expect(page.locator(".vr-table")).toHaveCount(1);
    await expect(page.locator(".vr-table th")).toHaveCount(2);
  });

  test("Today's date inserts a link to today in the reader's format", async ({ page }) => {
    await openEditing(page, "Popup Slash Today", "- x");
    await page.keyboard.type(" /today");
    await rowsOf(page).filter({ hasText: "Today's date" }).click();
    const text = await editorText(page);
    expect(text).toMatch(/^x \[\[.+\]\]$/);
    // The same title the stream shows for today.
    await page.goto("/journals");
    const title = (await page.locator(".journal-day-today .journal-day-title").textContent()) ?? "";
    expect(text).toBe(`x [[${title.replace(" · Today", "").trim()}]]`);
  });

  test("Page reference inserts [[ and chains into the page popup (R47)", async ({ page }) => {
    await openEditing(page, "Popup Slash PageRef", "- x");
    await page.keyboard.type(" /wikilink");
    await expect(activeRow(page)).toHaveText("Page reference");
    await activeRow(page).click();
    await expect(editor(page)).toHaveText("x [[");
    // The popup that is open now is the PAGE one, not a lingering slash menu. The click moved
    // focus off the editor (B-71), so click back in before typing the query.
    await editor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("q");
    await expect(popup(page)).toHaveCount(1);
    await expect(rowsOf(page).filter({ hasText: 'New page "q"' })).toHaveCount(1);
  });
});
