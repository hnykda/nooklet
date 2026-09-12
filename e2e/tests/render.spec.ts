/**
 * The two render seams wired in M7 (research/13 §4.2 item 9): code fences are syntax-highlighted
 * and `$…$` renders through KaTeX — both in the rendered view and (math) inside the editing
 * surface — and both load lazily, so a page with neither never fetches their chunks.
 */
import { expect, type Page, test } from "@playwright/test";
import { clickAway, editor, openEditing, openPage } from "../helpers/index.js";

const LAZY_CHUNK = /highlighter-impl|math-impl|katex/;

function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}

test("a plain page loads neither the highlighter nor KaTeX", async ({ page }) => {
  const urls = recordRequests(page);
  await openPage(page, "Render Plain", "- just words, no code, no maths");
  await page.waitForLoadState("networkidle");
  expect(urls.filter((u) => LAZY_CHUNK.test(u))).toEqual([]);
});

test("a ```js fence is highlighted once its grammar chunk arrives", async ({ page }) => {
  const urls = recordRequests(page);
  const outliner = await openPage(page, "Render Code", "- ```js\n  const x = 1; // hi\n  ```");
  const fence = outliner.locator("pre.vr-fence[data-lang=js]");
  await expect(fence).toBeVisible();
  await expect(fence.locator("code .hljs-keyword").first()).toHaveText("const");
  await expect(fence.locator("code .hljs-comment")).toHaveText("// hi");
  await expect(fence.locator("code")).toHaveText("const x = 1; // hi");
  expect(urls.some((u) => /highlighter-impl/.test(u))).toBe(true);
  expect(urls.some((u) => /math-impl|katex/.test(u))).toBe(false);
});

test("an unknown language stays plain text", async ({ page }) => {
  const outliner = await openPage(page, "Render Unknown", "- ```nosuchlang\n  const x = 1;\n  ```");
  const code = outliner.locator("pre.vr-fence[data-lang=nosuchlang] code");
  await expect(code).toHaveText("const x = 1;");
  // Give a would-be highlighter time to land, then confirm nothing was wrapped.
  await page.waitForTimeout(300);
  await expect(code.locator("span")).toHaveCount(0);
});

test("inline $…$ renders through KaTeX in the rendered view", async ({ page }) => {
  const urls = recordRequests(page);
  const outliner = await openPage(page, "Render Math", "- Euler: $e^{i\\pi}+1=0$ is neat");
  const math = outliner.locator(".vr-math");
  await expect(math).toHaveClass(/vr-math-rendered/);
  await expect(math.locator(".katex")).toBeVisible();
  // The dollar delimiters are syntax, not content, once rendered.
  await expect(math).not.toContainText("$");
  expect(urls.some((u) => /math-impl/.test(u))).toBe(true);
});

test("inside the editor, math is a widget until the caret touches it", async ({ page }) => {
  await openEditing(page, "Render Math Edit", "- $x^2$ and words");
  // Caret is at the end (after "words"): the token is not touched, so the widget shows.
  await expect(editor(page).locator(".katex")).toBeVisible();

  // Home puts the caret at offset 0 — adjacent to the token — which reveals the source.
  await page.keyboard.press("Home");
  await expect(editor(page).locator(".katex")).toHaveCount(0);
  await expect(editor(page)).toContainText("$x^2$");

  // And the widget is atomic: one Right from the end skips the whole formula.
  await page.keyboard.press("End");
  await expect(editor(page).locator(".katex")).toBeVisible();

  await clickAway(page);
});
