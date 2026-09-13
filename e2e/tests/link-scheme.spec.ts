/**
 * B-268: `[me](javascript:…)` rendered as a clickable `href`. Link text is content from sync and
 * from MCP agents, so a script-running scheme must never reach the browser.
 */
import { expect, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

test("a javascript: link renders without an href; web and mail links keep theirs (B-268)", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Link Scheme Guard",
    "- click [me](javascript:document.title='PWNED') here\n- [site](https://example.com) and [mail](mailto:a@example.com)",
  );
  const rows = outliner.locator(".vr-row");
  const bad = rows.nth(0).locator("a.vr-link");
  await expect(bad).toHaveText("me");
  await expect(bad).not.toHaveAttribute("href", /.*/);

  await expect(rows.nth(1).locator("a.vr-link").nth(0)).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(rows.nth(1).locator("a.vr-link").nth(1)).toHaveAttribute(
    "href",
    "mailto:a@example.com",
  );

  const title = await page.title();
  const popup = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  await bad.click({ modifiers: [] });
  expect(await popup).toBeNull();
  expect(await page.title()).toBe(title);
});
