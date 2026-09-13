/**
 * The built-in plugins' client halves, in the real app (B-103, ADR 023). Before the client plugin
 * host they were dead on arrival: the server listed them, nothing in the browser loaded them — no
 * `/mermaid`, a ```` ```mermaid ```` fence rendered as a plain `<pre>`, and no word count anywhere.
 * Every assertion here is on something a person sees, or on what the server stored.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, clickAway, openEditing, openPage, readBlocks } from "../helpers/index.js";

const STARTER = "```mermaid\ngraph TD\n  A --> B\n```";

function wordCount(page: Page) {
  return page.locator('[data-status-item="word-count"]');
}

test("/mermaid is in the slash menu and inserts a diagram that renders", async ({ page }) => {
  const name = "Plugins Mermaid Slash";
  const outliner = await openEditing(page, name, "- intro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/merm");

  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toHaveText("Mermaid diagram");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);

  // What the plugin inserted, as stored (live preview hides fence markup in the editor).
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content), { timeout: 15_000 })
    .toEqual(["intro", STARTER]);

  // Out of edit mode, the plugin's renderer draws it: mermaid's chunks load on this first diagram.
  await clickAway(page);
  const diagram = outliner.locator(".vr-row").nth(1).locator(".vr-plugin-fence svg");
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toContainText("A");
  await expect(diagram).toContainText("B");
});

test("a mermaid fence renders as a diagram, not as code", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Plugins Mermaid Fence",
    "- ```mermaid\n  graph LR\n    Zahrada --> Sklizen\n  ```\n- ```js\n  const x = 1;\n  ```",
  );
  const mermaid = outliner.locator('.vr-plugin-fence[data-lang="mermaid"]');
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(mermaid.locator("svg")).toContainText("Zahrada");
  await expect(mermaid.locator("pre")).toHaveCount(0);
  // A fence no plugin claims is still the ordinary highlighted code block.
  await expect(outliner.locator('pre.vr-fence[data-lang="js"] code')).toHaveText("const x = 1;");
  await expect(outliner.locator('.vr-plugin-fence[data-lang="js"]')).toHaveCount(0);
});

test("a broken mermaid fence says why instead of rendering nothing", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Plugins Mermaid Broken",
    "- ```mermaid\n  this is not a diagram %%%\n  ```",
  );
  const fence = outliner.locator('.vr-plugin-fence[data-lang="mermaid"]');
  await expect(fence).toContainText("mermaid: render failed", { timeout: 30_000 });
});

test("word count shows the open page's words and follows edits (audit item 14)", async ({
  page,
}) => {
  const name = "Plugins Word Count";
  // 2 + 3 + 1 = 6 words across three blocks, one of them a child.
  await openEditing(page, name, "- dobré ráno\n  - three more words\n- end");
  await expect(wordCount(page)).toHaveText("6 words");

  // Typing is a local write first; the count is read through the server half's RPC, so it must
  // follow once the push lands rather than stay at the number from page open.
  await page.keyboard.type(" plus two");
  await clickAway(page);
  await expect(wordCount(page)).toHaveText("8 words", { timeout: 20_000 });
  expect((await readBlocks(page, name))[0]?.content).toBe("dobré ráno plus two");
});

test("word count follows in-app navigation and is gone where no single page is open", async ({
  page,
}) => {
  await api(page, "page.create", {
    name: "Plugins Words One",
    if_exists: "return",
    markdown: "- one",
  });
  // The server counts whitespace-separated tokens of the stored text: "[[Plugins", "Words",
  // "One]]" are three of the seven.
  const outliner = await openPage(
    page,
    "Plugins Words Seven",
    "- one two three four [[Plugins Words One]]",
  );
  await expect(wordCount(page)).toHaveText("7 words");

  // Client-side navigation, not a reload: the host must notice the route change by itself.
  await outliner.locator(".vr-page-ref", { hasText: "Plugins Words One" }).click();
  await expect(page).toHaveURL(/\/page\/Plugins%20Words%20One$/);
  await expect(wordCount(page)).toHaveText("1 word");

  await page.locator(".app-history button[aria-label='Back']").click();
  await expect(wordCount(page)).toHaveText("7 words");

  // The journals stream shows many days; there is no one page to count, so no stale number either.
  if ((await page.locator(".app-sidebar").count()) === 0) {
    await page.locator("button[aria-label='Toggle sidebar']").click();
  }
  await page.locator(".app-sidebar").getByRole("link", { name: "Journals" }).click();
  await expect(page).toHaveURL(/\/journals$/);
  await expect(wordCount(page)).toHaveText("");
  await expect(wordCount(page)).toBeHidden();
});
