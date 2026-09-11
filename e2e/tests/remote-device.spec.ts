/**
 * The self-hosted scenario: a phone (or any non-loopback device) reaching a nooklet server over a
 * network, pairing with a token, and syncing.
 *
 * A remote device is simulated by answering `GET /api/session` the way the server answers a
 * non-loopback `Host` — a token of `null`. That is the real mechanism the client depends on
 * (`server/src/http/app.ts#buildClientBootstrap`), rather than a stub of the client's internals,
 * so these keep working if the client changes how it stores or reads its token.
 */

import { expect, test } from "@playwright/test";

test("a loopback browser is handed a token and never sees the connect screen", async ({ page }) => {
  await page.goto("/journals");
  await expect(page.locator(".connect")).toHaveCount(0);
  const token = await page.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string | null } }).__NOOKLET__?.token,
  );
  expect(token).toBeTruthy();
});

test("a device with no token gets the connect screen, and pairing works", async ({ page }) => {
  // Mint a real sync-capable token through the API, the way `nooklet token create` would.
  await page.goto("/journals");
  const adminToken = await page.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token,
  );
  expect(adminToken).toBeTruthy();

  // Simulate a remote device by answering `/api/session` the way the server answers a
  // non-loopback Host — which is the real mechanism, not a stub of the client's internals.
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  await page.evaluate(() => localStorage.removeItem("nooklet.deviceToken"));
  await page.goto("/journals");

  const connect = page.locator(".connect");
  await expect(connect).toBeVisible();
  await expect(connect).toContainText("nooklet token create");
  // It must explain WHY, not just refuse.
  await expect(connect).toContainText("same machine as the server");

  // A bad token is rejected with a readable message rather than a silent permanent "offline".
  await connect.locator("input").fill("nk_definitely_not_a_real_token");
  await connect.locator('button[type="submit"]').click();
  await expect(connect.locator(".connect-error")).toContainText("rejected");

  // A real one pairs, stores, and reloads into the app.
  await connect.locator("input").fill(adminToken as string);
  await connect.locator('button[type="submit"]').click();

  await expect(page.locator(".connect")).toHaveCount(0, { timeout: 15_000 });
  const stored = await page.evaluate(() => localStorage.getItem("nooklet.deviceToken"));
  expect(stored).toBe(adminToken);
  // And it is genuinely usable: the app booted with the stored token while `/api/session`
  // continued to refuse one.
  await expect(page.locator(".vr-outliner, .vr-draft-input").first()).toBeVisible();
});

test("a paired remote device can read the graph it was given access to", async ({ page }) => {
  await page.goto("/journals");
  const token = await page.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token,
  );
  await page.evaluate(
    async ([t]) => {
      const call = (op: string, body: unknown) =>
        fetch(`/api/v1/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
          body: JSON.stringify(body),
        });
      await call("page.create", { name: "Shared From Desktop" });
      await call("page.append", {
        page: "Shared From Desktop",
        markdown: "- written on the desktop",
      });
    },
    [token] as const,
  );

  // Pair as a "remote" device carrying only the stored token, then read what the other device wrote.
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  await page.evaluate((t) => localStorage.setItem("nooklet.deviceToken", t as string), token);

  await page.goto("/page/Shared%20From%20Desktop");
  await expect(page.locator(".connect")).toHaveCount(0);
  await expect(page.locator(".vr-outliner").first()).toContainText("written on the desktop");
});
