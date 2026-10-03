/**
 * Rendering and view gaps fixed together on `m9/render-views`: B-224 (a multi-line block's lines
 * run together), B-211 (a query result is found before the real row), B-200 (a page that does not
 * exist yet shows its references). The phone half of this work — B-225 — is
 * `render-views-phone.spec.ts`, since a device descriptor is per file.
 *
 * Page names here all start with "RV " so they cannot collide with another spec's on the shared
 * server.
 */

import { expect, test } from "@playwright/test";
import {
  api,
  isoOffset,
  openPage,
  pagePath,
  readBlocks,
  seedPage,
  withBase,
} from "../helpers/index.js";

test("a multi-line block renders each line on its own line (B-224)", async ({ page }) => {
  const outliner = await openPage(
    page,
    "RV Multiline",
    "- Poznámka: **žluťoučký kůň**\n  second line\n- plain first\n  plain second",
  );
  // Stored with the newline — the defect was in rendering, not in the import.
  const blocks = await readBlocks(page, "RV Multiline");
  expect(blocks.map((b) => b.content)).toEqual([
    "Poznámka: **žluťoučký kůň**\nsecond line",
    "plain first\nplain second",
  ]);

  const rows = outliner.locator(".vr-row .vr-block-view");
  await expect(rows).toHaveCount(2);
  for (const [index, [first, second]] of [
    ["žluťoučký kůň", "second line"],
    ["plain first", "plain second"],
  ].entries()) {
    const view = rows.nth(index);
    await expect(view.locator("br")).toHaveCount(1);
    // What a reader sees: the second line starts BELOW the first, not after it on the same line.
    const tops = await view.evaluate(
      (el, [a, b]) => {
        const topOf = (text: string): number => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent?.indexOf(text) ?? -1;
            if (i === -1) continue;
            const range = document.createRange();
            range.setStart(n, i);
            range.setEnd(n, i + 1);
            return range.getBoundingClientRect().top;
          }
          return Number.NaN;
        };
        return [topOf(a as string), topOf(b as string)];
      },
      [first, second],
    );
    expect(tops[1]).toBeGreaterThan((tops[0] ?? 0) + 5);
    // `innerText` follows layout, so it shows the break the way a copy would.
    expect(await view.evaluate((el) => (el as HTMLElement).innerText)).toContain(`\n${second}`);
  }
});

test("on a desktop the title row keeps History and the icon slot behind hover; the menu has both (B-225)", async ({
  page,
}) => {
  const name = "RV Desktop Title Row";
  await openPage(page, name, "- a block");
  const row = page.locator(".page-title-row");
  const history = row.locator(".page-history-link");
  const slot = row.locator(".page-icon-button-empty");
  const opacity = (l: typeof history) => l.evaluate((el) => getComputedStyle(el).opacity);
  // Unchanged on a fine pointer: in the row, muted until hovered.
  await page.mouse.move(0, 0);
  await expect.poll(() => opacity(history)).toBe("0");
  await expect.poll(() => opacity(slot)).toBe("0");
  await row.hover();
  await expect.poll(() => opacity(history)).toBe("1");
  await expect.poll(() => opacity(slot)).toBe("1");

  await page.getByRole("button", { name: "Page actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Page history" })).toHaveAttribute(
    "href",
    withBase(page, "/history/RV%20Desktop%20Title%20Row"),
  );
  await page.getByRole("menuitem", { name: "Add icon" }).click();
  await expect(page.locator(".page-actions-menu")).toHaveCount(0);
  await expect(page.locator(".page-icon-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(slot).toHaveCount(1);
});

test("revealing a block lands on its row, not on a query result above it (B-211)", async ({
  page,
}) => {
  const name = "RV Query Reveal";
  const outliner = await openPage(
    page,
    name,
    [
      "- ```query",
      "  TODO tag:rvreveal",
      "  ```",
      `- put [[${name}]] on the shelf`,
      "- TODO rv reveal target #rvreveal",
    ].join("\n"),
  );
  const target = (await readBlocks(page, name)).find((b) => b.content.includes("rv reveal target"));
  expect(target).toBeDefined();
  const id = target?.id as string;
  // The query renders its result ABOVE the row it found — the shape the entry describes.
  await expect(outliner.locator(".vr-query-hit", { hasText: "rv reveal target" })).toHaveCount(1);

  // Every `[data-block-id]` for this block is its outliner row: that attribute is how "which DOM
  // node is block X" is answered (`shell/Shelf.tsx`, `live/RemoteFlashOverlay.tsx`).
  const owners = await page.evaluate(
    (blockId) =>
      [...document.querySelectorAll(`[data-block-id="${CSS.escape(blockId)}"]`)].map(
        (el) => el.className,
      ),
    id,
  );
  expect(owners).toHaveLength(1);
  expect(owners[0]).toContain("vr-row");

  // The real gesture: shelve the page, switch the card to its outline, click the task's entry.
  // `[data-from]`: the link in the block's text, not the query group's page heading.
  await outliner
    .locator(".vr-page-ref[data-from]", { hasText: name })
    .click({ modifiers: ["Shift"] });
  const card = page.locator(".shelf-card").first();
  await card.getByRole("button", { name: "Show page outline" }).click();
  await card.locator(".shelf-toc-link", { hasText: "rv reveal target" }).click();
  await expect(page.locator(`.vr-row[data-block-id="${id}"]`)).toHaveClass(/shelf-reveal-target/);
  await expect(outliner.locator(".vr-query-hit.shelf-reveal-target")).toHaveCount(0);
});

test("a page nobody wrote but something links shows what links to it and what is tagged with it (B-200)", async ({
  page,
}) => {
  const name = "RV Unwritten Book";
  await seedPage(page, "RV Book Reader", `- reading [[${name}]] tonight`);
  await api(page, "page.create", {
    name: "RV Book Tagged",
    if_exists: "return",
    properties: { tags: name },
  });
  // A plain mention: an unlinked reference on a real page.
  await seedPage(page, "RV Book Mention", `- ${name} came up in passing`);

  // The link made the page exist (ADR 024): the ordinary view, empty, with everything pointing at
  // it. ("Doesn't exist yet" with references is now a journal day's view — the next test.)
  await page.goto(pagePath(name));
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(name);
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".vr-empty-start")).toBeVisible();
  const tagged = page.getByRole("region", { name: `Pages tagged ${name}` });
  await expect(tagged.locator(".tagged-page-link")).toHaveText(["RV Book Tagged"]);
  const linked = page.locator(".linked-references");
  await expect(linked.locator(".reference-group-page")).toHaveText(["RV Book Reader"]);
  await expect(linked.locator(".reference-item")).toContainText("reading");
  await expect(page.locator(".unlinked-references")).toBeVisible();

  // A reference still goes where it says.
  await linked.locator(".reference-group-page", { hasText: "RV Book Reader" }).click();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("RV Book Reader");
});

test("a journal day nobody has written shows the links to it, whatever date format the URL uses (B-200)", async ({
  page,
}) => {
  // An offset no other spec uses, so no journal page exists there.
  const iso = isoOffset(-333);
  await seedPage(page, "RV Date Linker", `- remember [[${iso}]] for the review`);
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][m - 1];
  const suffix =
    d % 10 === 1 && d !== 11
      ? "st"
      : d % 10 === 2 && d !== 12
        ? "nd"
        : d % 10 === 3 && d !== 13
          ? "rd"
          : "th";
  // Logseq's default title format, as an old link or a typed URL would spell it.
  await page.goto(pagePath(`${month} ${d}${suffix}, ${y}`));
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await expect(page.locator(".linked-references .reference-group-page")).toHaveText([
    "RV Date Linker",
  ]);
});

test("the Tasks view's due window finds a deadline on a task that is also scheduled (B-171)", async ({
  page,
}) => {
  // Dates years out, so no other spec's task falls in the window; rows are matched by text anyway.
  await seedPage(
    page,
    "RV Tasks Window",
    [
      "- TODO rvtw scheduled early, deadline inside",
      "  scheduled:: 2031-03-01",
      "  deadline:: 2031-03-20",
      "- TODO rvtw scheduled inside",
      "  scheduled:: 2031-03-18",
      "- TODO rvtw scheduled early only",
      "  scheduled:: 2031-03-01",
    ].join("\n"),
  );
  await page.goto("/tasks");
  const rows = page.locator(".task-group", { hasText: "RV Tasks Window" }).locator(".task-row");
  await expect(rows).toHaveCount(3);

  await page.locator("label", { hasText: "Due from" }).locator("input").fill("2031-03-15");
  await page.locator("label", { hasText: "Due to" }).locator("input").fill("2031-03-25");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "deadline inside" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "scheduled inside" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "scheduled early only" })).toHaveCount(0);
});

test("clicking the empty line of a multi-line block puts the caret on that line, not at the block's end (B-325)", async ({
  page,
}) => {
  // B-224 made an empty line inside a block visible (two `<br>`s). There is no text on it for the
  // browser to hit, so a click there resolves to a position BETWEEN the paragraph's children, and
  // `caret.ts` — which only knew how to walk up from a text node — sent the caret to the end of the
  // block. 214 blocks in the owner's graph have an empty line like this.
  const name = "RV Blank Line Click";
  const outliner = await openPage(
    page,
    name,
    [
      "- alpha",
      "  ",
      "  gamma",
      "- Úvod **tučně**",
      "  ",
      "  konec",
      "- první",
      "  ",
      "  druhý",
      "  rvblank:: ano",
    ].join("\n"),
  );
  const before = await readBlocks(page, name);
  expect(before.map((b) => b.content)).toEqual([
    "alpha\n\ngamma",
    "Úvod **tučně**\n\nkonec",
    "první\n\ndruhý",
  ]);

  const typed = ["beta", "střed", "prostřední"];
  for (const [index, text] of typed.entries()) {
    const view = outliner.locator(".vr-row .vr-block-view").nth(index);
    await expect(view.locator("br")).toHaveCount(2);
    // The middle of the empty line: halfway between the two breaks' tops is still the first line,
    // so aim at the second break's own line box.
    const point = await view.evaluate((el) => {
      const second = el.querySelectorAll("br")[1] as HTMLBRElement;
      const b = second.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { x: box.width / 2, y: b.top + b.height / 2 - box.top };
    });
    await view.click({ position: point });
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press("Escape");
  }

  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["alpha\nbeta\ngamma", "Úvod **tučně**\nstřed\nkonec", "první\nprostřední\ndruhý"]);
});

test("a page that does not exist yet keeps its references panel, and its place in it, when another page is written (B-326)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  // A journal day: since ADR 024 a linked ordinary name is a page, and a day nobody wrote is what
  // still shows the missing view with references. An offset no other spec uses.
  const name = isoOffset(-777);
  for (let p = 0; p < 6; p++) {
    await seedPage(
      page,
      `RV Keep Place Linker ${p}`,
      Array.from({ length: 4 }, (_, i) => `- řádek ${i} o [[${name}]]`).join("\n"),
    );
  }
  await page.goto(pagePath(name));
  await expect(page.locator(".page-view-missing")).toBeVisible();
  const groups = page.locator(".linked-references .reference-group-page");
  await expect(groups).toHaveCount(6);

  // Read far enough down the list that losing the place would show.
  const scroller = page.locator(".page-scroll");
  await groups.last().evaluate((el) => el.scrollIntoView({ block: "end" }));
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.evaluate(() => {
    const w = window as unknown as { rvPanel: Element | null; rvLoadingSeen: boolean };
    w.rvPanel = document.querySelector(".references-panel");
    w.rvLoadingSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".references-loading")) w.rvLoadingSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Another page written elsewhere, the way an agent or another device does. It tags the target, so
  // the panel showing it is proof the write has arrived and been re-read — every page write
  // refetches the page lookup, and that refetch is what used to take the view down.
  await api(page, "page.create", {
    name: "RV Keep Place Tagger",
    if_exists: "return",
    properties: { tags: name },
  });
  await expect(
    // Titled with the day as the reader reads dates, not the ISO name.
    page.getByRole("region", { name: /^Pages tagged / }).locator(".tagged-page-link"),
  ).toHaveText(["RV Keep Place Tagger"]);

  const after = await page.evaluate(() => {
    const w = window as unknown as { rvPanel: Element | null; rvLoadingSeen: boolean };
    return {
      samePanel: w.rvPanel !== null && w.rvPanel === document.querySelector(".references-panel"),
      loadingSeen: w.rvLoadingSeen,
    };
  });
  expect(after).toEqual({ samePanel: true, loadingSeen: false });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);

  // Navigating on to a page that exists still leaves the missing view, and back again shows it.
  await groups.first().click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".page-title-input")).toHaveValue(/RV Keep Place Linker/);
  await page.goBack();
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await expect(groups).toHaveCount(6);
});
