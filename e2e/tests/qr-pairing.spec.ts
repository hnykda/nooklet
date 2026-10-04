/**
 * QR pairing with one-time codes and device management (B-655), across two browser contexts
 * against one real `nooklet serve`:
 *
 *   A — the desktop-like admin session: a loopback browser, handed the `admin` web-client token.
 *   B — "the phone": a second context whose `/api/session` answers like a non-loopback device
 *       (`token: null`), so it has no credential until it pairs.
 *
 * A opens Settings → Devices, shows a pairing QR; B opens the pairing URL, uses "this browser",
 * names itself and connects; B shows up in A's list; A revokes it; B's HTTP sync is refused and
 * its live sync socket is closed by the server.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator(".set-panel")).toBeVisible();
}

async function asRemoteDevice(context: BrowserContext): Promise<void> {
  // The real mechanism a non-loopback device meets: the server hands it no token.
  await context.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
}

function storedToken(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const graphs = JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as Array<{
      id: string;
      token?: string;
    }>;
    const activeId = localStorage.getItem("nooklet.activeGraphId");
    return graphs.find((g) => g.id === activeId)?.token;
  });
}

test("pair a second device by QR URL, see it listed, revoke it, and its sync stops", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  // --- A: the admin session -------------------------------------------------------------------
  await page.goto("/journals");
  await expect(page.locator(".vr-outliner, .vr-draft-input").first()).toBeVisible();
  await openSettings(page);
  const devices = page.locator("#set-devices");
  await expect(devices).toBeVisible();
  // This session itself is listed, without a Revoke button.
  await expect(devices.getByTestId("device-row").filter({ hasText: "this session" })).toHaveCount(
    1,
  );

  await devices.getByRole("button", { name: "Add a device" }).click();
  // On loopback the page cannot guess the phone's address; the owner types it.
  const address = devices.getByLabel("Address your phone uses to reach this server");
  await expect(address).toHaveValue("");
  await address.fill(baseURL as string);
  await devices.getByRole("button", { name: "Show pairing code" }).click();
  const urlText = await devices.getByTestId("pairing-url").textContent();
  expect(urlText).toMatch(/\/g\/default\/pair#code=nkp_[A-Za-z0-9_-]{22}$/);
  const qr = devices.getByAltText("Pairing QR code");
  await expect(qr).toBeVisible();
  await expect(devices.getByTestId("pairing-countdown")).toHaveText(/^(10:00|9:[0-5]\d)$/);
  // Kept for the decode probe (`tools/probes/qr-decode/`): proves the QR encodes this URL.
  await qr.screenshot({ path: testInfo.outputPath("pairing-qr.png") });
  await testInfo.attach("pairing-url", { body: urlText as string, contentType: "text/plain" });

  // --- B: the new device ----------------------------------------------------------------------
  const phone = await browser.newContext();
  await asRemoteDevice(phone);
  const b = await phone.newPage();
  await b.goto(urlText as string);
  await expect(b.getByRole("heading", { name: "Pair this device with nooklet" })).toBeVisible();
  // The fragment is gone from the address bar once read.
  expect(new URL(b.url()).hash).toBe("");
  const appLink = await b.getByTestId("pair-open-app").getAttribute("href");
  const app = new URL(appLink as string);
  expect(app.protocol).toBe("nooklet:");
  expect(app.searchParams.get("url")).toBe(`${baseURL}/g/default`);
  expect(urlText).toContain(app.searchParams.get("code") as string);

  await b.getByTestId("pair-use-browser").click();
  const dialog = b.getByRole("dialog", { name: "Pairing link" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name this device").fill("E2E phone");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(b.locator(".connect")).toHaveCount(0, { timeout: 15_000 });
  await expect(b.locator(".vr-outliner, .vr-draft-input").first()).toBeVisible();
  const phoneToken = await storedToken(b);
  expect(phoneToken).toMatch(/^nk_/);

  // B's credential works for sync, and opens a live socket.
  const before = await b.evaluate(async (t) => {
    const res = await fetch("/g/default/sync/pull?device_id=e2ephone&since=0&limit=1", {
      headers: { authorization: `Bearer ${t}` },
    });
    return res.status;
  }, phoneToken);
  expect(before).toBe(200);
  await b.evaluate((t) => {
    const w = window as unknown as { __closeCode?: number };
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/g/default/sync/live`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", device_id: "e2ephone", token: t }));
    ws.onclose = (e) => {
      w.__closeCode = e.code;
    };
  }, phoneToken);

  // The code was single use: the same URL again is refused.
  const reuse = await b.evaluate(async (code) => {
    const res = await fetch("/g/default/api/v1/pairing.redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: "again" }),
    });
    return res.status;
  }, app.searchParams.get("code"));
  expect(reuse).toBe(401);

  // --- A sees it arrive, and revokes it -------------------------------------------------------
  await expect(devices.getByTestId("pairing-done")).toHaveText("Paired: E2E phone.", {
    timeout: 15_000,
  });
  const row = devices.getByTestId("device-row").filter({ hasText: "E2E phone" });
  await expect(row).toContainText("write + sync");
  await row.getByRole("button", { name: "Revoke" }).click();
  const confirm = page.locator(".confirm-dialog");
  await expect(confirm).toContainText('Revoke "E2E phone"?');
  await confirm.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);

  // --- B's sync stops ---------------------------------------------------------------------------
  await expect
    .poll(() => b.evaluate(() => (window as unknown as { __closeCode?: number }).__closeCode))
    .toBe(4401);
  const after = await b.evaluate(async (t) => {
    const res = await fetch("/g/default/sync/pull?device_id=e2ephone&since=0&limit=1", {
      headers: { authorization: `Bearer ${t}` },
    });
    return res.status;
  }, phoneToken);
  expect(after).toBe(401);
  // The app itself notices at its next sync and says so.
  await b.reload();
  await expect(b.getByRole("button", { name: "Token rejected", exact: true })).toBeVisible({ timeout: 20_000 });
  await phone.close();
});

test("a write-scoped session sees no Devices section", async ({ browser }) => {
  // A phone's token: write + sync, minted through the CLI-equivalent path (a pairing code).
  const admin = await browser.newPage();
  await admin.goto("/journals");
  const adminToken = await admin.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token,
  );
  const writeToken = await admin.evaluate(async (t) => {
    const call = async (op: string, body: unknown, auth?: string) =>
      (
        await fetch(`/g/default/api/v1/${op}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify(body),
        })
      ).json();
    const { code } = await call("pairing.create", {}, t);
    return (await call("pairing.redeem", { code, label: "write-only phone" })).token as string;
  }, adminToken);
  await admin.close();

  const ctx = await browser.newContext();
  await asRemoteDevice(ctx);
  const p = await ctx.newPage();
  await p.goto("/journals");
  await p.evaluate((t) => {
    localStorage.setItem(
      "nooklet.graphs",
      JSON.stringify([
        { id: "e2e-write", label: "Remote", kind: "local", baseUrl: "/g/default", token: t },
      ]),
    );
    localStorage.setItem("nooklet.activeGraphId", "e2e-write");
  }, writeToken);
  await p.goto("/journals");
  await expect(p.locator(".vr-outliner, .vr-draft-input").first()).toBeVisible();
  await openSettings(p);
  await expect(p.locator("#set-plugins")).toBeVisible(); // the panel did load its sections
  await expect(p.locator("#set-devices")).toHaveCount(0);
  await ctx.close();
});
