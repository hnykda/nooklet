/**
 * B-615: opened over plain http on a non-loopback origin, the app used to accept a token and then
 * show a blank white page — the browser withholds OPFS, `navigator.locks` and `crypto.randomUUID`
 * outside a secure context (B-27), and nothing said so.
 *
 * The insecure origin is `http://nooklet-insecure.test`, which Chromium does not treat as secure
 * (not HTTPS, not loopback). Its requests are answered by the suite's real server through
 * `route.fetch`, so this is the real production build on a genuinely insecure origin — not a stubbed
 * `isSecureContext`. Fetched from loopback, the server even hands out a token, which is the worst
 * case the sweep hit: credentials fine, app dead.
 */

import { expect, test } from "@playwright/test";

const INSECURE = "http://nooklet-insecure.test";

test("a non-secure origin explains why the app cannot run, and how to fix it", async ({
  page,
  context,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route(`${INSECURE}/**`, async (route) => {
    const url = new URL(route.request().url());
    // Redirects (bare `/static/…` → `/g/default/static/…`) are followed here, server-side: a
    // redirect handed back to the browser is not routed again, and the made-up host has no DNS.
    // Without the made-up Origin: the server's MCP Host/Origin guard refuses a foreign one (the
    // same trap the sweep found behind a reverse proxy), which is not what this test is about.
    const { origin: _origin, referer: _referer, ...headers } = route.request().headers();
    const res = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}`, headers });
    await route.fulfill({ response: res });
  });

  await page.goto(`${INSECURE}/g/default/journals`);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

  const main = page.locator("main.connect-insecure");
  await expect(
    main.getByRole("heading", { name: "nooklet needs a secure connection" }),
  ).toBeVisible();
  await expect(main).toContainText(INSECURE);
  await expect(main).toContainText("tailscale serve");
  await expect(main).toContainText("HTTPS");
  await expect(main).toContainText("http://localhost/g/default/journals");
  // It is this page, not a token form that cannot lead anywhere, and nothing threw on the way.
  await expect(page.locator(".connect input")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a secure (loopback) origin still starts the app", async ({ page }) => {
  await page.goto("/journals");
  await expect(page.locator("main.connect-insecure")).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toBeVisible();
});
