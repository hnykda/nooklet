/**
 * Probe (2026-09-13, m11/ref-pages, ADR 024): what does the server actually receive while someone
 * types or edits a page link? Settles whether "the server creates a page for every reference"
 * would also create a page for every half-typed name.
 *
 * Questions:
 *  1. Does typing `[[` insert a closing `]]` before the name is finished (auto-pairing)?
 *  2. What `block.text` contents reach `/sync/push` while a link is typed at a fast (80 ms/char)
 *     and a slow (700 ms/char, longer than the 500 ms edit flush) pace?
 *  3. Same, when an EXISTING link is edited character by character in the middle.
 *  4. Same for a `#tag` typed slowly.
 *
 * Every `/sync/push` body is recorded; the output lists each distinct `block.text` content in push
 * order, and the page links (`[[…]]`, `#tag`) each one contains.
 *
 * Not part of the suite (it prints; it does not assert). To re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, editorText, isoOffset, openEditing } from "../helpers/index.js";

function recordPushes(page: Page): string[] {
  const texts: string[] = [];
  page.on("request", (req) => {
    if (!req.url().includes("/sync/push")) return;
    const body = req.postDataJSON() as {
      ops?: Array<{ payload: { kind: string; content?: string } }>;
    };
    for (const op of body.ops ?? []) {
      if (op.payload.kind === "block.text" && typeof op.payload.content === "string") {
        texts.push(op.payload.content);
      }
      if (op.payload.kind === "page.create")
        texts.push(`<page.create ${JSON.stringify(op.payload)}>`);
    }
  });
  return texts;
}

function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]]*)\]\]/g)) out.push(`[[${m[1]}]]`);
  for (const m of text.matchAll(/(?:^|\s)#([^\s#]+)/g)) out.push(`#${m[1]}`);
  return out;
}

function report(label: string, texts: string[]): void {
  const lines = texts.map((t) => `    ${JSON.stringify(t)}  links=${JSON.stringify(linksIn(t))}`);
  const names = new Set(texts.flatMap(linksIn));
  console.log(
    `--- ${label}: ${texts.length} pushed text op(s), ${names.size} distinct link(s)\n${lines.join("\n")}`,
  );
}

async function clickAway(page: Page): Promise<void> {
  await page.locator("h1, .page-title-input").first().click();
  await page.waitForTimeout(1500);
}

for (const [pace, delay] of [
  ["fast", 80],
  ["slow", 700],
] as const) {
  test(`probe: typing a new namespaced link, ${pace} (${delay} ms/char)`, async ({ page }) => {
    const name = `Probe typing ${pace} ${Date.now().toString(36)}`;
    await openEditing(page, name, "- start");
    const texts = recordPushes(page);
    await page.keyboard.type(" see [[", { delay: 80 });
    await page.waitForTimeout(300);
    console.log(`after "[[": buffer=${JSON.stringify(await editorText(page))}`);
    await page.keyboard.type("Probe Sprouts/Growing/Sixth Try", { delay });
    console.log(`after the name: buffer=${JSON.stringify(await editorText(page))}`);
    await page.keyboard.press("Escape");
    await page.keyboard.type("]]", { delay: 80 });
    console.log(`after typing "]]": buffer=${JSON.stringify(await editorText(page))}`);
    await clickAway(page);
    report(`new link, ${pace}`, texts);
  });
}

test("probe: editing an existing link character by character (700 ms/char)", async ({ page }) => {
  const name = `Probe edit link ${Date.now().toString(36)}`;
  await openEditing(page, name, "- see [[Probe Foo]] here");
  const texts = recordPushes(page);
  // Caret is at the end; walk back over " here" and "]]" to sit right after "Foo".
  for (let i = 0; i < " here]]".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("bar baz", { delay: 700 });
  await page.keyboard.press("Escape");
  console.log(`after editing: buffer=${JSON.stringify(await editorText(page))}`);
  await clickAway(page);
  report("existing link edited", texts);
  await expect(page.locator(".vr-outliner").first()).toContainText("Probe Foobar baz");
});

test("probe: typing a #tag slowly (700 ms/char)", async ({ page }) => {
  const name = `Probe tag ${Date.now().toString(36)}`;
  await openEditing(page, name, "- start");
  const texts = recordPushes(page);
  await page.keyboard.type(" #probetag", { delay: 700 });
  await page.keyboard.press("Escape");
  await page.keyboard.type(" done", { delay: 80 });
  await clickAway(page);
  report("#tag typed", texts);
});

/**
 * 5. Would an empty journal page — one a date reference could create — show as a day in the
 * journal stream? A day three days back gets a page with one block, the block is deleted, and the
 * stream is read.
 */
test("probe: an existing journal page with no blocks in the journal stream", async ({ page }) => {
  const day = isoOffset(-3);
  const appended = await api<{ created: string[] }>(page, "page.append", {
    page: day,
    markdown: "- probe block",
  });
  for (const id of appended.created) await api(page, "block.delete", { id });
  const tree = await api<{ tree?: unknown[] }>(page, "page.read", { page: day, format: "json" });
  console.log(`page ${day} exists with ${tree.tree?.length ?? 0} live top-level block(s)`);
  await page.goto("/journals");
  await expect(page.locator(".journal-day-today")).toBeVisible();
  await page.waitForTimeout(1500);
  const titles = await page.locator(".journal-day-title").allTextContents();
  console.log(`journal stream day titles: ${JSON.stringify(titles)}`);
  const empties = await page.locator(".vr-empty-start").count();
  console.log(
    `sections: ${await page.locator("section.journal-day").count()}; empty rows: ${empties}`,
  );
});
