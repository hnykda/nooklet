/**
 * Block text is untrusted input: it arrives by sync, by import and from agents over MCP, and the
 * renderer must not let it do more than show itself. Each test seeds the text through the API —
 * the way an agent or a synced device would put it there — and checks what reaches the DOM (or a
 * new window) in the real build.
 *
 * - B-137: Alt+Enter on an asset link opens the asset, not `/page/assets/…` (B-51 on the keyboard
 *   path).
 * - B-138: a `[label](javascript:…)` link gets no `href`, and Alt+Enter on it opens nothing; a
 *   fence's info string cannot add app classes; KaTeX cannot paint a 99999em box.
 */

import { expect, test } from "@playwright/test";
import { openEditing, openPage, withBase } from "../helpers/index.js";

test("Alt+Enter on an asset link opens the asset from the server root, not below the page route", async ({
  page,
  baseURL,
}) => {
  // A namespaced page: the route is two segments deep, so a relative href would land on
  // /page/Untrusted/assets/… — the shape B-51 fixed for rendered links. "The server root" is now
  // this graph's own root (ADR 025 — `/g/default/`), not necessarily the bare origin.
  await openEditing(page, "Untrusted/Asset Link", "- [spec](../assets/rv-sec-spec.pdf)");
  const popup = page.context().waitForEvent("page");
  await page.keyboard.press("Alt+Enter");
  const opened = await popup;
  await expect
    .poll(() => opened.url())
    .toBe(`${baseURL}${withBase(page, "/assets/rv-sec-spec.pdf")}`);
  await opened.close();
});

test("a javascript: link renders without an href, and Alt+Enter on it opens nothing", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Untrusted JS Link",
    "- [click me](javascript:alert(document.domain))\n- [data](data:text/html,<script>alert(1)</script>)\n- [fine](https://example.com/x)",
  );
  const links = outliner.locator("a.vr-link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).not.toHaveAttribute("href", /./);
  await expect(links.nth(1)).not.toHaveAttribute("href", /./);
  await expect(links.nth(2)).toHaveAttribute("href", "https://example.com/x");

  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  let popups = 0;
  page.context().on("page", () => {
    popups++;
  });
  await page.keyboard.press("Alt+Enter");
  // Nothing to wait for when nothing happens; give a popup the time one takes to appear (the
  // unfixed build opened an about:blank one well within this window).
  await page.waitForTimeout(1000);
  expect(popups).toBe(0);
});

test("a fence's info string names a language, not arbitrary classes", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Untrusted Fence Class",
    "- ```js cmd-overlay vr-row\n  const x = 1;\n  ```",
  );
  const code = outliner.locator("pre.vr-fence code");
  await expect(code).toHaveCount(1);
  // Wait for the highlighted branch (it carries `hljs`), so both class bindings are exercised.
  await expect(code).toHaveClass(/\bhljs\b/);
  const classes = ((await code.getAttribute("class")) ?? "").split(/\s+/);
  expect(classes).toEqual(["language-js", "hljs"]);
  await expect(page.locator(".cmd-overlay")).toHaveCount(0);
});

test("a KaTeX size command cannot paint a page-covering box", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Untrusted Math Size",
    "- $\\rule{99999em}{99999em}$\n- $\\kern99999em x$ after a kern",
  );
  const math = outliner.locator(".vr-math-rendered");
  await expect(math).toHaveCount(2);
  // Before the cap this row was 1,574,998 px tall.
  const row = outliner.locator(".vr-row").first();
  expect((await row.boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
  expect((await math.first().boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(2000);
  // `\kern` is not capped by KaTeX; the row's containment must keep it from widening the page.
  const widest = await page.evaluate(() => {
    let max = document.documentElement.scrollWidth;
    for (let el = document.querySelector(".vr-outliner"); el; el = el.parentElement) {
      max = Math.max(max, el.scrollWidth);
    }
    return max;
  });
  expect(widest).toBeLessThan(5000);
});
