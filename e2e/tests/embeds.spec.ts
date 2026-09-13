/**
 * `{{embed ((id))}}` / `{{embed [[Page]]}}` (B-210, audit 2026-09-12 §2 item 8): the embedded
 * block's subtree or the page's blocks render read-only inside the host block, rows click through,
 * the frame still edits the host, edits to the target show up live, and self-embedding pages and
 * chains stop (a cycle notice, the depth limit) instead of hanging the page.
 *
 * The shape of the first test is the owner's real use: a journal-style list collapsed on the day
 * it was written, embedded on a later day to carry it forward.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  api,
  clickAway,
  editor,
  editorText,
  openPage,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

const SOURCE = "Embed Source";
const SOURCE_MARKDOWN = [
  "- unrelated first block",
  "- todo list",
  "  collapsed:: true",
  "  - TODO buy **milk**",
  "  - call bob",
  "    collapsed:: true",
  "    - about the car",
  "  - pay rent",
].join("\n");

async function blockId(page: Page, pageName: string, content: string): Promise<string> {
  const blocks = await readBlocks(page, pageName);
  const hit = blocks.find((b) => b.content === content);
  if (!hit) throw new Error(`no block "${content}" on ${pageName}: ${JSON.stringify(blocks)}`);
  return hit.id;
}

async function openBlockEmbed(page: Page, host: string) {
  await seedPage(page, SOURCE, SOURCE_MARKDOWN);
  const id = await blockId(page, SOURCE, "todo list");
  const outliner = await openPage(page, host, `- carried over:\n- {{embed ((${id}))}}`);
  const embed = outliner.locator(".vr-embed.vr-embed-block");
  await expect(embed.locator(".vr-embed-item").first()).toBeVisible();
  return { outliner, embed, id };
}

test("a block embed shows the block and its children, read-only, root unfolded", async ({
  page,
}) => {
  const { outliner, embed } = await openBlockEmbed(page, "Embed Host Show");
  // The root was folded on its own page; in the embed it is open. "call bob" stays folded, so
  // "about the car" is not a row.
  await expect(embed.locator(".vr-embed-item")).toHaveCount(4);
  await expect(embed.locator(".vr-embed-content")).toHaveText([
    "todo list",
    "buy milk",
    "call bob",
    "pay rent",
  ]);
  await expect(embed.locator(".vr-embed-source")).toHaveText(SOURCE);
  await expect(embed.locator(".vr-embed-item .vr-marker-TODO")).toHaveCount(1);
  await expect(embed).not.toContainText("about the car");
  // Embedded rows are not outliner rows: the host page still has exactly its own two.
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect(page.locator(".cm-content")).toHaveCount(0);

  // The toggle unfolds inside the embed only.
  await embed.locator(".vr-embed-toggle[aria-expanded=false]").click();
  await expect(embed).toContainText("about the car");
  await expect(page).toHaveURL(/\/page\/Embed%20Host%20Show$/);
});

test("clicking an embedded row opens that block; clicking the frame edits the host", async ({
  page,
}) => {
  const { embed, id } = await openBlockEmbed(page, "Embed Host Nav");
  const bob = await blockId(page, SOURCE, "call bob");
  await embed.locator(".vr-embed-item", { hasText: "call bob" }).locator(".vr-embed-row").click();
  await expect(page).toHaveURL(new RegExp(`/page/Embed%20Source\\?block=${bob}$`));
  await expect(page.locator(".cm-content")).toHaveCount(0);

  await page.goBack();
  const head = page.locator(".vr-embed-head");
  await expect(head).toBeVisible();
  const box = await head.boundingBox();
  if (!box) throw new Error("embed head has no box");
  // The right-hand end of the source line: frame, not the page link.
  await head.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await expect(editor(page)).toBeFocused();
  expect(await editorText(page)).toBe(`{{embed ((${id}))}}`);
  await clickAway(page);
  await expect(page.locator(".vr-embed-item").first()).toBeVisible();
});

test("Shift+click on an embedded row shelves that block, from its own page (B-215)", async ({
  page,
}) => {
  const { embed } = await openBlockEmbed(page, "Embed Host Shelf Row");
  await embed
    .locator(".vr-embed-item", { hasText: "call bob" })
    .locator(".vr-embed-row")
    .click({ modifiers: ["Shift"] });
  const card = page.locator(".app-shelf .shelf-card").first();
  await expect(card).toBeVisible();
  // The card reads the block from the page it lives on, not the page the embed is written on.
  await expect(card).not.toContainText("This block is gone.");
  await expect(card.locator(".shelf-block-text").first()).toHaveText("call bob");
  await expect(card).toContainText(SOURCE);
  // Shelving is not navigating.
  await expect(page).toHaveURL(/\/page\/Embed%20Host%20Shelf%20Row$/);
});

test("a web link inside an embedded row opens the link, not the block (B-216)", async ({
  page,
  context,
}) => {
  // Never leave the machine: the "site" is answered locally.
  await context.route("https://example.com/**", (r) => r.fulfill({ status: 200, body: "b216" }));
  await seedPage(page, "Embed Link Source", "- links\n  - read https://example.com/b216 later");
  const id = await blockId(page, "Embed Link Source", "links");
  const outliner = await openPage(page, "Embed Link Host", `- {{embed ((${id}))}}`);
  const link = outliner.locator(".vr-embed-item a.vr-link");
  await expect(link).toBeVisible();

  const popup = context.waitForEvent("page");
  await link.click();
  expect((await popup).url()).toBe("https://example.com/b216");
  // The app stayed where it was, and did not drop the host into edit mode either.
  await expect(page).toHaveURL(/\/page\/Embed%20Link%20Host$/);
  await expect(page.locator(".cm-content")).toHaveCount(0);
});

test("typing elsewhere on the page leaves an embed in place, unfolded rows included (B-214)", async ({
  page,
}) => {
  const { outliner, embed } = await openBlockEmbed(page, "Embed Host Typing");
  await embed.locator(".vr-embed-toggle[aria-expanded=false]").click();
  await expect(embed).toContainText("about the car");
  // Tag the rendered outline and watch the host row's height: a rebuilt embed is a new element,
  // and on the way it shows the one-line placeholder, which is what made the page jump.
  await embed.locator(".vr-embed-outline").evaluate((el) => {
    (el as HTMLElement & { __b214?: boolean }).__b214 = true;
    const row = el.closest(".vr-row") as HTMLElement;
    const w = window as unknown as { __b214Min: number };
    w.__b214Min = row.getBoundingClientRect().height;
    new ResizeObserver(() => {
      w.__b214Min = Math.min(w.__b214Min, row.getBoundingClientRect().height);
    }).observe(row);
  });
  const tall = await outliner
    .locator(".vr-row")
    .nth(1)
    .evaluate((r) => r.getBoundingClientRect().height);

  await outliner.locator(".vr-row").first().locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  // Wait for the write to land in the replica and the page tree to re-read.
  await expect
    .poll(async () => (await readBlocks(page, "Embed Host Typing"))[0]?.content)
    .toBe("carried over: and more");
  await clickAway(page);
  await expect(outliner.locator(".vr-row").first().locator(".vr-block-view")).toHaveText(
    "carried over: and more",
  );

  await expect(embed).toContainText("about the car");
  expect(
    await embed
      .locator(".vr-embed-outline")
      .evaluate((el) => (el as HTMLElement & { __b214?: boolean }).__b214 === true),
  ).toBe(true);
  const min = await page.evaluate(() => (window as unknown as { __b214Min: number }).__b214Min);
  expect(min).toBeGreaterThan(tall / 2);
});

test("an embed follows edits to its target without a reload", async ({ page }) => {
  const { embed } = await openBlockEmbed(page, "Embed Host Live");
  const rent = await blockId(page, SOURCE, "pay rent");
  await api(page, "block.update", { id: rent, old_str: "pay rent", new_str: "pay rent today" });
  await expect(embed.locator(".vr-embed-content").last()).toHaveText("pay rent today");
  await api(page, "block.update", { id: rent, old_str: "pay rent today", new_str: "pay rent" });
  await expect(embed.locator(".vr-embed-content").last()).toHaveText("pay rent");
});

test("a page embed shows the page's blocks under its name", async ({ page }) => {
  await seedPage(page, "Embed Reading List", "- Books\n  - Dune\n- Articles");
  const outliner = await openPage(page, "Embed Host Page", "- {{embed [[Embed Reading List]]}}");
  const embed = outliner.locator(".vr-embed.vr-embed-page");
  await expect(embed.locator(".vr-embed-content")).toHaveText(["Books", "Dune", "Articles"]);
  await embed.locator(".vr-embed-source").click();
  await expect(page).toHaveURL(/\/page\/Embed%20Reading%20List$/);
});

test("a page that embeds itself shows a notice and stays editable", async ({ page }) => {
  const outliner = await openPage(page, "Embed Loop", "- intro\n- {{embed [[Embed Loop]]}}");
  await expect(outliner.locator(".vr-embed-cycle")).toBeVisible();
  await expect(outliner.locator(".vr-embed-item")).toHaveCount(0);
  // The page did not hang: typing into its first block still works.
  await outliner.locator(".vr-row").first().locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" still here");
  expect(await editorText(page)).toBe("intro still here");
});

test("on the shelf, a self-embedding block shows the notice rather than a copy of its page", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Embed Loop Shelf",
    "- intro\n- {{embed [[Embed Loop Shelf]]}}",
  );
  // Shift+click the notice's text (not its link) shelves the host block.
  await outliner.locator(".vr-embed-cycle .vr-embed-note").click({ modifiers: ["Shift"] });
  const card = page.locator(".app-shelf .shelf-card").first();
  await expect(card.locator(".vr-embed-cycle")).toBeVisible();
  await expect(card.locator(".vr-embed-item")).toHaveCount(0);
});

test("two pages embedding each other stop one level down", async ({ page }) => {
  await seedPage(page, "Embed Pong", "- pong\n- {{embed [[Embed Ping]]}}");
  const outliner = await openPage(page, "Embed Ping", "- ping {{embed [[Embed Pong]]}}");
  await expect(outliner.locator(".vr-embed-cycle")).toHaveCount(1);
  // Ping's row shows Pong's two blocks; Pong's embed of Ping would show Ping's row again.
  await expect(outliner.locator(".vr-embed-item")).toHaveCount(2);
});

test("a chain of embeds stops at the depth limit with a link", async ({ page }) => {
  await seedPage(page, "Embed Chain D", "- the end");
  await seedPage(page, "Embed Chain C", "- c {{embed [[Embed Chain D]]}}");
  await seedPage(page, "Embed Chain B", "- b {{embed [[Embed Chain C]]}}");
  const outliner = await openPage(page, "Embed Chain A", "- a {{embed [[Embed Chain B]]}}");
  const limit = outliner.locator(".vr-embed-limit");
  await expect(limit).toBeVisible();
  await expect(limit).toContainText("[[Embed Chain D]]");
  await expect(outliner).not.toContainText("the end");
  await limit.locator(".vr-embed-target").click();
  await expect(page).toHaveURL(/\/page\/Embed%20Chain%20D$/);
});

test("an embed of a block that does not exist says so", async ({ page }) => {
  const outliner = await openPage(page, "Embed Missing", "- {{embed ((1nosuchblock0))}}");
  await expect(outliner.locator(".vr-embed-missing")).toContainText(
    "Embedded block not found: ((1nosuchblock0))",
  );
});

test("a finished task inside an embed or a query result does not strike through its host (B-212)", async ({
  page,
}) => {
  await seedPage(
    page,
    "Embed Done Source",
    "- list\n  - DONE finished b212done\n  - TODO still open",
  );
  const outliner = await openPage(
    page,
    "Embed Done Host",
    "- {{embed [[Embed Done Source]]}}\n- ```query\n  text:b212done\n  ```",
  );
  const decoration = (el: Element): string => getComputedStyle(el).textDecorationLine;
  const embedRow = outliner.locator(".vr-row").nth(0);
  const queryRow = outliner.locator(".vr-row").nth(1);
  const doneInEmbed = embedRow.locator(".vr-embed-item", { hasText: "finished" });
  await expect(doneInEmbed.locator(".vr-marker-DONE")).toBeVisible();
  await expect(queryRow.locator(".vr-query-hit .vr-marker-DONE")).toBeVisible();

  // The finished item itself recedes...
  expect(await doneInEmbed.locator(".vr-embed-content").evaluate(decoration)).toBe("line-through");
  expect(await queryRow.locator(".vr-query-hit-content").first().evaluate(decoration)).toBe(
    "line-through",
  );
  // ...the block that merely shows it does not (text-decoration cannot be undone by a child, so a
  // struck host strikes every open item and the source line with it).
  expect(await embedRow.locator(".vr-block-view").evaluate(decoration)).toBe("none");
  expect(await queryRow.locator(".vr-block-view").evaluate(decoration)).toBe("none");

  // Same rule on the shelf: Shift+click the embed's frame shelves the host block, whose card renders
  // the embed again.
  const head = embedRow.locator(".vr-embed-head");
  const box = await head.boundingBox();
  if (!box) throw new Error("embed head has no box");
  await head.click({ modifiers: ["Shift"], position: { x: box.width - 4, y: box.height / 2 } });
  const card = page.locator(".app-shelf .shelf-card").first();
  await expect(card.locator(".vr-embed-item .vr-marker-DONE")).toBeVisible();
  expect(await card.locator(".shelf-block-text").first().evaluate(decoration)).toBe("none");
});
