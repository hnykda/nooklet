/**
 * ADR 024: a page exists once something references it — in the browser, against the real server.
 *
 * The owner's report: `/page/Sprouts/Growing/Sixth%20Try` said "doesn't exist yet" although a
 * journal block linked it, and the page was missing from the graph and All pages. Every name here
 * carries a per-run stamp: the server is shared by every spec in a run, and page counts are taken
 * before and after within one test.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, clickAway, editor, isoOffset, MOD, pagePath, readBlocks } from "../helpers/index.js";

const stamp = Date.now().toString(36);

/** Every live page name the server lists, for counting junk. */
async function pageNames(page: Page): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const out = await api<{ items: Array<{ name: string }>; cursor?: string }>(page, "page.list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    names.push(...out.items.map((i) => i.name));
    cursor = out.cursor;
  } while (cursor);
  return names;
}

async function pageExists(page: Page, name: string): Promise<boolean> {
  const names = await pageNames(page);
  return names.some((n) => n.toLowerCase() === name.toLowerCase());
}

/** A journal day far enough back that no other spec writes to it, opened with the caret at the end
 * of its one block. */
async function openJournalBlock(page: Page, dayOffset: number, text: string): Promise<string> {
  const day = isoOffset(dayOffset);
  await api(page, "page.append", { page: day, markdown: `- ${text}` });
  await page.goto(pagePath(day));
  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view", { hasText: text }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  return day;
}

/** Type a `[[link]]` the way a person does: the popup opens at `[[`, Escape dismisses it, `]]`
 * closes the link by hand (no auto-pairing, `tools/probes/ref-link-typing.spec.ts`). */
async function typeLink(page: Page, name: string): Promise<void> {
  await page.keyboard.type(" [[", { delay: 20 });
  await page.keyboard.type(name, { delay: 10 });
  await page.keyboard.press("Escape");
  await page.keyboard.type("]]", { delay: 20 });
}

test("a [[namespaced link]] typed in a journal block opens as a normal page, and its ancestors exist", async ({
  page,
}) => {
  const root = `Sprouts ${stamp}`;
  const name = `${root}/Growing/Sixth Try`;
  await openJournalBlock(page, -610, `mushroom log ${stamp}`);
  await typeLink(page, name);
  await clickAway(page);

  await expect.poll(() => pageExists(page, name), { timeout: 10_000 }).toBe(true);
  expect(await pageExists(page, root)).toBe(true);
  expect(await pageExists(page, `${root}/Growing`)).toBe(true);

  await page.locator(".vr-page-ref", { hasText: "Sixth Try" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/page/Sprouts%20${stamp}/Growing/Sixth%20Try$`));
  // A normal page: its editable title, somewhere to type, what links to it — not "Create".
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(name);
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".vr-empty-start")).toBeVisible();
  await expect(page.locator(".reference-item").first()).toContainText(`mushroom log ${stamp}`);

  // And it can be typed into like any page.
  await page.locator(".vr-empty-start").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("first flush", { delay: 20 });
  await clickAway(page);
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first flush"]);
});

test("a page only a link made is in All pages, the graph, search and the [[ popup", async ({
  page,
}) => {
  const name = `Linked Only ${stamp}`;
  await openJournalBlock(page, -611, `graph source ${stamp}`);
  await typeLink(page, name);
  await clickAway(page);
  await expect.poll(() => pageExists(page, name), { timeout: 10_000 }).toBe(true);

  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill(name);
  await expect(page.locator(".all-pages-row")).toHaveCount(1);
  await expect(page.locator(".all-pages-row")).toContainText(name);

  await page.goto("/graph");
  const wrap = page.locator(".graph-canvas-wrap");
  await expect(wrap).toHaveAttribute("data-settled", "true", { timeout: 20_000 });
  await expect(page.locator(`.graph-node-list li a:text-is("${name}")`)).toHaveCount(1);

  const found = await api<{ hits?: Array<{ page: string }> }>(page, "search", {
    query: `Linked Only ${stamp}`,
    mode: "keyword",
  });
  expect(JSON.stringify(found)).toContain(name);

  // The `[[` popup offers it as an existing page — no "New page" row for its exact name.
  await openJournalBlock(page, -612, `popup check ${stamp}`);
  await page.keyboard.type(" [[", { delay: 20 });
  await page.keyboard.type(`Linked Only ${stamp}`, { delay: 10 });
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row", { hasText: name }).first()).toBeVisible();
  await expect(popup.locator(".cmd-row", { hasText: "New page" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("editing an existing link one character at a time leaves no junk pages", async ({ page }) => {
  const base = `Junk Probe ${stamp}`;
  const day = await openJournalBlock(page, -613, `edit me ${stamp}`);
  await typeLink(page, base);
  await clickAway(page);
  await expect.poll(() => pageExists(page, base), { timeout: 10_000 }).toBe(true);
  const before = await pageNames(page);

  // Back into the block, caret right after the name, and a slow edit: every pause is a flush of a
  // complete, different link (the probe measured 7 distinct names for this shape).
  // At the row's left edge: the middle of the text is now the link, and a click there follows it.
  const pushedLinks = new Set<string>();
  page.on("request", (req) => {
    if (!req.url().includes("/sync/push")) return;
    for (const m of (req.postData() ?? "").matchAll(/\[\[(Junk Probe [^\]]*)\]\]/g)) {
      pushedLinks.add(m[1] as string);
    }
  });
  const outliner = page.locator(".vr-outliner").first();
  await outliner
    .locator(".vr-block-view", { hasText: `edit me ${stamp}` })
    .click({ position: { x: 4, y: 4 } });
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press(`${MOD}+End`); // the block wraps: plain End stops at the visual line
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(" Final", { delay: 650 });
  await page.keyboard.press("Escape");
  await clickAway(page);

  const final = `${base} Final`;
  await expect.poll(() => pageExists(page, final), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(async () => (await readBlocks(page, day)).map((b) => b.content))
    .toContain(`edit me ${stamp} [[${final}]]`);
  // The server really was sent half-edited names (otherwise this test proves nothing)…
  expect(pushedLinks.size).toBeGreaterThanOrEqual(3);
  // …and kept none of them.
  const after = await pageNames(page);
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  expect(added).toEqual([final]);
  expect(removed).toEqual([base]);
  // And nothing of it in the trash.
  const trash = await api<{ items: Array<{ title: string }> }>(page, "trash.list", { limit: 100 });
  expect(trash.items.filter((i) => i.title.startsWith(base))).toEqual([]);
});

test("deleting the only link removes the empty page it made, but not a page someone typed into", async ({
  page,
}) => {
  const untouched = `Untouched ${stamp}`;
  const written = `Written In ${stamp}`;
  const day = await openJournalBlock(page, -614, `two links ${stamp}`);
  await typeLink(page, untouched);
  await typeLink(page, written);
  await clickAway(page);
  await expect.poll(() => pageExists(page, written), { timeout: 10_000 }).toBe(true);
  expect(await pageExists(page, untouched)).toBe(true);

  await page.goto(pagePath(written));
  await page.locator(".vr-empty-start").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("I was here", { delay: 20 });
  await clickAway(page);
  await expect
    .poll(async () => (await readBlocks(page, written)).map((b) => b.content))
    .toEqual(["I was here"]);

  // The links go, through the editor: back into the block, and Backspace over both of them.
  await page.goto(pagePath(day));
  await page
    .locator(".vr-outliner")
    .first()
    .locator(".vr-block-view", { hasText: `two links ${stamp}` })
    .click({ position: { x: 4, y: 4 } });
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press(`${MOD}+End`);
  const links = ` [[${untouched}]] [[${written}]]`;
  for (let i = 0; i < links.length; i++) await page.keyboard.press("Backspace");
  await clickAway(page);
  await expect
    .poll(async () => (await readBlocks(page, day)).map((b) => b.content))
    .toContain(`two links ${stamp}`);

  await expect.poll(() => pageExists(page, untouched), { timeout: 10_000 }).toBe(false);
  expect(await pageExists(page, written)).toBe(true);
  // The removed one never reaches the trash; the kept one was never deleted.
  const trash = await api<{ items: Array<{ title: string }> }>(page, "trash.list", { limit: 100 });
  expect(trash.items.filter((i) => i.title === untouched)).toEqual([]);
  // In the UI too: All pages no longer lists it.
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill(stamp);
  await expect(page.locator(".all-pages-row", { hasText: untouched })).toHaveCount(0);
  await expect(page.locator(".all-pages-row", { hasText: written })).toHaveCount(1);
});

test("a page created offline under a name another device's link made converges: one page, no lost block", async ({
  browser,
}) => {
  const name = `Race Page ${stamp}`;
  const offline = await browser.newContext();
  const online = await browser.newContext();
  try {
    const a = await offline.newPage();
    const b = await online.newPage();
    // What A sends once back online, to show the race really happened: A's own `page.create`.
    const pushedByA: string[] = [];
    a.on("request", (req) => {
      if (req.url().includes("/sync/push")) pushedByA.push(req.postData() ?? "");
    });

    // Device A has the page's URL open: nothing links it yet, so it offers Create.
    await a.goto(pagePath(name));
    await expect(a.locator(".page-view-missing")).toBeVisible();
    await offline.setOffline(true);

    // Device B links it; the server makes the page.
    await openJournalBlock(b, -615, `race link ${stamp}`);
    await typeLink(b, name);
    await clickAway(b);
    await expect.poll(() => pageExists(b, name), { timeout: 10_000 }).toBe(true);

    // A, still offline, never heard: it creates the page itself and writes in it.
    await a.waitForTimeout(500);
    await expect(a.locator(".page-view-missing")).toBeVisible();
    await a.locator(".page-view-missing button").click();
    await expect(editor(a)).toBeFocused();
    await a.keyboard.type("written while offline", { delay: 20 });
    await a.locator(".page-title-input").click();
    await a.waitForTimeout(800);

    await offline.setOffline(false);
    // Nudge the lifecycle the way coming back online does in a real browser.
    await a.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 20_000 })
      .toEqual(["written while offline"]);
    const same = (await pageNames(b)).filter((n) => n.toLowerCase() === name.toLowerCase());
    expect(same).toEqual([name]);
    expect(pushedByA.some((body) => body.includes('"page.create"') && body.includes(name))).toBe(
      true,
    );

    // Both devices show the one page with the block.
    await b.goto(pagePath(name));
    await expect(b.locator(".vr-outliner").first()).toContainText("written while offline");
    await a.goto(pagePath(name));
    await expect(a.locator(".vr-outliner").first()).toContainText("written while offline");
    await expect(a.locator(".page-view-missing")).toHaveCount(0);
  } finally {
    await offline.close();
    await online.close();
  }
});

test("what an offline device typed into a linked page survives another device removing the link (B-445)", async ({
  browser,
}) => {
  const name = `Offline Draft ${stamp}`;
  const linking = await browser.newContext();
  const offline = await browser.newContext();
  try {
    const a = await linking.newPage();
    const b = await offline.newPage();

    // A links the page; the server makes it.
    const day = await openJournalBlock(a, -616, `offline draft link ${stamp}`);
    await typeLink(a, name);
    await clickAway(a);
    await expect.poll(() => pageExists(a, name), { timeout: 10_000 }).toBe(true);

    // B has it open as the empty page it is, then loses the network and types into it.
    await b.goto(pagePath(name));
    await expect(b.locator(".vr-empty-start")).toBeVisible();
    await offline.setOffline(true);
    await b.locator(".vr-empty-start").click();
    await expect(editor(b)).toBeFocused();
    await b.keyboard.type("written while the link went", { delay: 20 });
    await b.locator(".page-title-input").click();
    await b.waitForTimeout(800);

    // Meanwhile A edits the link away, and the server removes the page nobody (it knows of) wrote in.
    await a
      .locator(".vr-outliner")
      .first()
      .locator(".vr-block-view", { hasText: `offline draft link ${stamp}` })
      .click({ position: { x: 4, y: 4 } });
    await expect(editor(a)).toBeFocused();
    await a.keyboard.press(`${MOD}+End`);
    const link = ` [[${name}]]`;
    for (let i = 0; i < link.length; i++) await a.keyboard.press("Backspace");
    await clickAway(a);
    await expect
      .poll(async () => (await readBlocks(a, day)).map((x) => x.content))
      .toContain(`offline draft link ${stamp}`);
    await expect.poll(() => pageExists(a, name), { timeout: 10_000 }).toBe(false);

    // B comes back: its writing is on a live page, for both devices, and not stranded in the trash.
    await offline.setOffline(false);
    await b.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect
      .poll(async () => (await readBlocks(a, name).catch(() => [])).map((x) => x.content), {
        timeout: 20_000,
      })
      .toEqual(["written while the link went"]);
    await a.goto(pagePath(name));
    await expect(a.locator(".vr-outliner").first()).toContainText("written while the link went");
    await expect(a.locator(".page-view-missing")).toHaveCount(0);
    await b.goto(pagePath(name));
    await expect(b.locator(".vr-outliner").first()).toContainText("written while the link went");
  } finally {
    await linking.close();
    await offline.close();
  }
});

test("typing on a page this device created offline carries on while sync moves it onto the server's page of that name", async ({
  browser,
}) => {
  // B-442's client repair removes the refused page and re-creates its blocks on the server's page
  // while the editor may be open in one of them: nothing typed before, during or after may be lost,
  // and the caret must stay in the block.
  const name = `Capture While Typing ${stamp}`;
  const offline = await browser.newContext();
  const online = await browser.newContext();
  try {
    const a = await offline.newPage();
    const b = await online.newPage();
    await a.goto(pagePath(name));
    await expect(a.locator(".page-view-missing")).toBeVisible();
    await offline.setOffline(true);
    await api(b, "page.append", { page: isoOffset(-617), markdown: `- link [[${name}]]` });
    await expect.poll(() => pageExists(b, name), { timeout: 10_000 }).toBe(true);

    await a.locator(".page-view-missing button").click();
    await expect(editor(a)).toBeFocused();
    await a.keyboard.type("first part", { delay: 20 });
    await a.waitForTimeout(800);
    await offline.setOffline(false);
    await a.evaluate(() => window.dispatchEvent(new Event("online")));
    await a.keyboard.type(" and the rest typed during sync", { delay: 60 });
    await a.waitForTimeout(1500);
    await expect(editor(a)).toBeFocused();
    await a.keyboard.type(" END", { delay: 40 });
    await a.locator(".page-title-input").click();
    await expect
      .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 20_000 })
      .toEqual(["first part and the rest typed during sync END"]);
    const same = (await pageNames(b)).filter((n) => n.toLowerCase() === name.toLowerCase());
    expect(same).toEqual([name]);
  } finally {
    await offline.close();
    await online.close();
  }
});
