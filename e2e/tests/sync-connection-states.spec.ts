/**
 * What the sync indicator says when the connection is not simply "fine" (B-613, B-614).
 *
 * B-613: a revoked or invalid stored token used to read "Offline — changes are kept and sent when
 * back online" forever, while no edit ever reached the server and nothing offered a way to fix it.
 * B-614: with the server down and nobody typing, the indicator said "Synced" indefinitely — the
 * live socket's close only scheduled a reconnect, and only a failed push or pull changed the state.
 *
 * A device whose token the server refuses is simulated the way `remote-device.spec.ts` simulates a
 * remote one: `/api/session` answers as it does for a non-loopback Host (no token), and the graph
 * entry carries a token the server's `token` table does not hold — exactly what `nooklet token
 * revoke` leaves behind, since a revoked and an unknown token both fail `verifyToken` alike.
 *
 * "The server is down" is a TCP proxy in front of the shared server that drops every connection
 * and stops listening (`../helpers/switchable-server.ts`, which says why nothing browser-side
 * works): what the client sees of a stopped server. The probe that found B-614
 * (`tools/probes/sweep-devices/edges.probe.ts`) killed a real one.
 */

import { expect, type Page, test } from "@playwright/test";
import { clickAway, readBlocks, seedPage } from "../helpers/index.js";
import { type SwitchableServer, startSwitchableServer } from "../helpers/switchable-server.js";

const SYNCED = "Synced";
const REJECTED = "Token rejected — changes stay on this device until you enter a new token";
const OFFLINE = "Offline — changes are kept and sent when back online";

/** The token the server hands a loopback caller — a valid, sync-capable one. */
async function loopbackToken(page: Page): Promise<string> {
  const res = await page.request.get("/g/default/api/session");
  const token = ((await res.json()) as { token?: string | null }).token;
  expect(token).toBeTruthy();
  return token as string;
}

/** Answer `/api/session` as the server does for a remote device: no token. */
async function actRemote(page: Page): Promise<void> {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
}

async function setEntryToken(page: Page, id: string, token: string, base: string): Promise<void> {
  await page.evaluate(
    ([i, t, b]) => {
      localStorage.setItem(
        "nooklet.graphs",
        JSON.stringify([{ id: i, label: "Remote", kind: "remote", token: t, baseUrl: b }]),
      );
      localStorage.setItem("nooklet.activeGraphId", i);
    },
    [id, token, base] as const,
  );
}

test("a refused token says so, keeps the edit, and re-pairing sends it", async ({ page }) => {
  test.setTimeout(60_000);
  const name = `Token Rejected ${Date.now() % 100000}`;
  // Not the app itself: a page on the same origin that does not start it, so the first app start
  // below is this entry's own (two starts in quick succession can leave the second without its
  // OPFS pool, on "memory", which is a different state from the one under test).
  await page.goto("/healthz");
  const good = await loopbackToken(page);
  const base = "/g/default";
  await seedPage(page, name, "- written before the token was revoked");

  // A paired remote device with a working token and a bootstrapped local replica.
  await actRemote(page);
  const entryId = `e2e-rejected-${Date.now()}`;
  await setEntryToken(page, entryId, good, base);
  await page.goto(`${base}/page/${encodeURIComponent(name)}`);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner).toContainText("written before the token was revoked");
  const indicator = page.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute("aria-label", SYNCED, { timeout: 15_000 });

  // The token is revoked: the entry keeps a token the server no longer accepts.
  await setEntryToken(page, entryId, "nk_revoked_0000000000000000", base);
  await page.reload();
  await expect(outliner).toContainText("written before the token was revoked");
  await expect(indicator).toHaveAttribute("aria-label", REJECTED, { timeout: 15_000 });
  await expect(indicator).toHaveAttribute("data-state", "unauthorized");

  // An edit made now stays local, and the indicator keeps saying why — not "Offline".
  await outliner.locator(".vr-block-view").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus an edit while refused", { delay: 10 });
  await clickAway(page);
  await page.waitForTimeout(1_500);
  await expect(indicator).toHaveAttribute("aria-label", REJECTED);
  expect((await readBlocks(page, name)).map((b) => b.content)).toEqual([
    "written before the token was revoked",
  ]);

  // The way back: re-enter a token for this same entry, address pre-filled and fixed.
  await page.getByRole("button", { name: "Token rejected", exact: true }).click();
  const repair = page.locator(".connect-repair");
  await expect(repair).toBeVisible();
  await expect(repair.getByLabel("Server address")).toHaveValue(
    `${new URL(page.url()).origin}${base}`,
  );
  await expect(repair.getByLabel("Server address")).toHaveAttribute("readonly", "");
  await repair.getByLabel("Device token").fill("nk_still_not_valid");
  await repair.getByRole("button", { name: "Connect" }).click();
  await expect(repair.locator(".connect-error")).toContainText("rejected");
  await repair.getByLabel("Device token").fill(good);
  await repair.getByRole("button", { name: "Connect" }).click();

  // Reloaded onto the same entry: the queued edit reaches the server, nothing was lost.
  await expect(indicator).toHaveAttribute("aria-label", SYNCED, { timeout: 20_000 });
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content), { timeout: 15_000 })
    .toEqual(["written before the token was revoked plus an edit while refused"]);
  const entries = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]"),
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe(entryId);
  expect(entries[0].token).toBe(good);
});

test.describe("the server going away (through a switchable proxy)", () => {
  let server: SwitchableServer;
  test.beforeAll(async () => {
    server = await startSwitchableServer();
  });
  test.afterAll(async () => {
    await server.dispose();
  });

  test("with nobody typing, Synced gives way to Offline, and comes back with the server", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(`${server.url}/journals`);
    const indicator = page.locator(".app-sync-indicator");
    await expect(indicator).toHaveAttribute("aria-label", SYNCED, { timeout: 20_000 });

    await server.down();
    // Nobody types. The grace period, then the dot's own attention delay, with margin.
    await expect(indicator).toHaveAttribute("aria-label", OFFLINE, { timeout: 10_000 });
    await expect(indicator).toHaveAttribute("data-state", "offline", { timeout: 5_000 });

    await server.up();
    // The socket's backoff decides when it next tries; at most its 30 s cap.
    await expect(indicator).toHaveAttribute("aria-label", SYNCED, { timeout: 35_000 });
    await expect(indicator).toHaveAttribute("data-state", "synced");
  });

  test("a blip the socket reconnects through never changes what the dot shows", async ({
    page,
  }) => {
    await page.goto(`${server.url}/journals`);
    const indicator = page.locator(".app-sync-indicator");
    await expect(indicator).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
    await indicator.evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { __dots: string[] }).__dots = seen;
      new MutationObserver(() => seen.push(el.getAttribute("data-state") ?? "")).observe(el, {
        attributes: true,
        attributeFilter: ["data-state"],
      });
    });

    // Down only long enough to drop the socket; its first retry (1 s later) finds the server back.
    await server.down();
    await server.up();
    await page.waitForTimeout(5_000);
    const dots = await page.evaluate(() => (window as unknown as { __dots: string[] }).__dots);
    expect(
      dots.filter((d) => d !== "synced"),
      JSON.stringify(dots),
    ).toEqual([]);
    await expect(indicator).toHaveAttribute("aria-label", SYNCED);
  });
});
