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

  // The caret is inside the diagram, so carrying on typing extends it. It used to sit after the
  // closing ```, where the first keystroke broke the fence (B-185).
  await page.keyboard.type(" --> C");
  const extended = "```mermaid\ngraph TD\n  A --> B --> C\n```";
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content), { timeout: 15_000 })
    .toEqual(["intro", extended]);

  // Out of edit mode, the plugin's renderer draws it: mermaid's chunks load on this first diagram.
  await clickAway(page);
  const diagram = outliner.locator(".vr-row").nth(1).locator(".vr-plugin-fence svg");
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toContainText("A");
  await expect(diagram).toContainText("B");
  await expect(diagram).toContainText("C");
});

// mermaid and its layout engines are ~6 MB of chunks (ADR 023): loaded for the first diagram,
// never for a page without one.
const MERMAID_CHUNK = /mermaid|elk-|cytoscape|dagre|flowDiagram/;

test("a page without a diagram loads none of mermaid's chunks", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await openPage(page, "Plugins No Diagram", "- ```js\n  const x = 1;\n  ```\n- words");
  // The plugins are up (this is the other plugin's output): "```js", "const", "x", "=", "1;",
  // "```", "words".
  await expect(wordCount(page)).toHaveText("7 words");
  await page.waitForLoadState("networkidle");
  expect(urls.filter((u) => MERMAID_CHUNK.test(u))).toEqual([]);
});

test("a mermaid fence renders as a diagram, not as code", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
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
  // Served by this origin's own build — nothing from a CDN.
  expect(urls.some((u) => /\/static\/mermaid\.core-/.test(u))).toBe(true);
  expect(urls.filter((u) => !u.startsWith(new URL(page.url()).origin))).toEqual([]);
});

test("a broken mermaid fence says why instead of rendering nothing", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Plugins Mermaid Broken",
    "- ```mermaid\n  this is not a diagram %%%\n  ```",
  );
  const fence = outliner.locator('.vr-plugin-fence[data-lang="mermaid"]');
  await expect(fence).toContainText("mermaid: render failed", { timeout: 30_000 });
  // …and only there: mermaid used to leave its "Syntax error in text" drawing in a temp
  // `div#dnooklet-mermaid-…` under <body>, one per failed render (B-184).
  await expect(page.locator('body > [id^="dnooklet-mermaid-"]')).toHaveCount(0);
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
});

test("a diagram stays drawn while another block on its page is edited (B-183)", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Plugins Mermaid Steady",
    "- ```mermaid\n  graph TD\n    Jaro --> Leto\n    Leto --> Podzim\n  ```\n- zapisuji",
  );
  await expect(outliner.locator(".vr-plugin-fence svg")).toBeVisible({ timeout: 30_000 });

  // Sample what every painted frame shows. Each write to the page re-creates its rows' rendered
  // content; the diagram used to drop back to its source for the tens of ms mermaid took to draw
  // it again, and the page jumped by the difference in height.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: boolean[]; __sampling: boolean };
    w.__frames = [];
    w.__sampling = true;
    const tick = () => {
      w.__frames.push(document.querySelector(".vr-outliner .vr-plugin-fence svg") !== null);
      if (w.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await page.keyboard.press("End");
  for (const word of [" jedna", " dva", " tři"]) {
    await page.keyboard.type(word);
    await page.waitForTimeout(800); // past the editor's ~500 ms coalescing: one write per word
  }
  await expect
    .poll(async () => (await readBlocks(page, "Plugins Mermaid Steady"))[1]?.content)
    .toBe("zapisuji jedna dva tři");

  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: boolean[]; __sampling: boolean };
    w.__sampling = false;
    return w.__frames;
  });
  expect(frames.length).toBeGreaterThan(30);
  expect(frames.filter((drawn) => !drawn)).toEqual([]);
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

test("deleting the open page asks word count about it without a 500 (B-610)", async ({ page }) => {
  const statuses: number[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/plugins/word-count/rpc/count")) statuses.push(res.status());
  });
  await openPage(page, "Plugins Words Doomed", "- soon gone");
  await expect(wordCount(page)).toHaveText("2 words");
  const before = statuses.length;

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete page" }).click();
  await expect(page).toHaveURL(/\/journals$/);

  // The delete fires `page.changed` while the page is still the current one, so the status item
  // asks the server about a page that no longer exists. That answer used to be a 500 with an
  // `OpError: no page named …` stack in the server log; now it is a 200 carrying null.
  await expect.poll(() => statuses.length).toBeGreaterThan(before);
  expect(statuses.filter((s) => s >= 500)).toEqual([]);
  await expect(wordCount(page)).toHaveText("");
});
