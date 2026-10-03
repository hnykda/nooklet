/**
 * B-631: "Discard the local copy and re-sync" (`views/GraphMismatchView.tsx`) deletes the
 * mismatched graph's replica and nothing else. It used to remove every OPFS entry — the
 * `opfs-sahpool` directory holds EVERY graph's replica on the device — so a local-only graph's
 * notes, which exist nowhere else, were lost with it.
 *
 * Emulated Capacitor shell, as in `local-graphs.spec.ts` (that file's header explains the setup),
 * so a local-only graph and a server graph can live side by side on one device. `/api/session`
 * answers with no token (a phone is not a loopback client) but with the graph's real identity, so
 * the mismatch check runs for real. The mismatch itself is made the way it happens in life, from
 * the client's side: the entry remembers a different graph identity than the server now reports.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

function rootToken(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return readFileSync(join(state.dataDir, "root.token"), "utf8").trim();
}

async function createGraph(base: string, id: string): Promise<string> {
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id, label: id }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function hits(base: string, graphId: string, token: string, text: string): Promise<number> {
  const res = await fetch(`${base}/g/${graphId}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: text, mode: "keyword" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hits: unknown[] }).hits.length;
}

async function capacitorContext(browser: Browser, base: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    serviceWorkers: "block",
  });
  await ctx.route(
    (url) =>
      url.origin === new URL(base).origin && (url.pathname === "/" || url.pathname === "/journals"),
    async (route) => {
      const shell = await route.fetch({ url: `${base}/g/default/journals` });
      await route.fulfill({ response: shell });
    },
  );
  await ctx.addInitScript(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: () => false,
      Plugins: {},
    };
  });
  // No token (a phone is not a loopback client), but a graph's real identity under `/g/<id>/`.
  // The un-prefixed `/api/session` a local-only load asks gets no identity: no graph is there.
  await ctx.route("**/api/session", async (route) => {
    const graphPath = /^\/g\/[^/]+\/api\/session$/.test(new URL(route.request().url()).pathname);
    let graphId: string | undefined;
    if (graphPath) {
      const real = await route.fetch();
      graphId = ((await real.json()) as { graphId?: string }).graphId;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host", graphId }),
    });
  });
  return ctx;
}

const today = (page: Page) => page.locator(".journal-day-today").first();

function marker(tag: string): string {
  return `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Type one line into today: the draft on an empty day, else a new last block. */
async function typeToday(page: Page, text: string): Promise<void> {
  const draft = today(page).locator(".vr-draft-input");
  const rows = today(page).locator(".vr-row:not(.vr-row-draft)");
  // Wait for the day to render first: a non-retrying `isVisible()` straight after a load takes
  // the wrong branch (B-543).
  await expect(draft.or(rows.first())).toBeVisible({ timeout: 15_000 });
  if (await draft.isVisible()) {
    await draft.fill(text);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
  } else {
    await today(page).locator(".vr-row:not(.vr-row-draft)").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(text, { delay: 10 });
    await page.keyboard.press("Escape");
  }
  await expect(today(page).locator(".vr-row:not(.vr-row-draft)", { hasText: text })).toBeVisible();
}

/** Until the B-247 copy of every write is gone: the worker has every op durably. */
async function waitForWritesApplied(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied-ops")).length,
      ),
    )
    .toBe(0);
}

test("B-631: discarding a mismatched graph's local copy keeps every other graph's replica", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(3 * 60_000);
  const base = baseURL as string;
  const graphId = `gm-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const localNote = marker("gmlocal");
  const syncedNote = marker("gmsynced");
  const unsyncedNote = marker("gmunsynced");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  // 1. A local-only graph with a note: it exists on this device and nowhere else.
  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  await typeToday(page, localNote);
  await waitForWritesApplied(page);

  // 2. A server graph next to it, with a note the server has.
  await page.getByRole("button", { name: "Switch graph" }).click();
  await page.getByText("Add a graph").click();
  await page.getByRole("button", { name: /Sync with a server/s }).click();
  await page.getByLabel("Server address").fill(`${base}/g/${graphId}`);
  await page.getByLabel("Device token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await typeToday(page, syncedNote);
  await expect.poll(() => hits(base, graphId, token, syncedNote), { timeout: 15_000 }).toBe(1);

  // 3. A note only in the server graph's replica (sync held off): it must go with the discard,
  //    which is how this test knows the replica really was deleted, not just left alone.
  //    Held off until the discard is done — the mismatched page's own worker would push it.
  await page.route(`**/g/${graphId}/sync/**`, (route) => route.abort());
  await typeToday(page, unsyncedNote);
  await waitForWritesApplied(page);

  // 4. The mismatch: this entry remembers a different graph than the server now reports.
  const entryId = await page.evaluate(() => {
    const active = localStorage.getItem("nooklet.activeGraphId");
    const graphs = JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as {
      id: string;
      graphInstanceId?: string;
    }[];
    const entry = graphs.find((g) => g.id === active);
    if (!entry?.graphInstanceId) throw new Error("the server entry has no remembered identity");
    entry.graphInstanceId = "an-earlier-graph-instance";
    localStorage.setItem("nooklet.graphs", JSON.stringify(graphs));
    return entry.id;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "This device holds a different graph" }),
  ).toBeVisible();

  // 5. Discard.
  await page.getByRole("button", { name: "Discard the local copy and re-sync" }).click();
  await expect(page.locator(".connect")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await hits(base, graphId, token, unsyncedNote)).toBe(0);
  await page.unroute(`**/g/${graphId}/sync/**`);
  await page.reload();

  // 6. The server graph re-synced from scratch: the server's note is back, the never-synced one
  //    went with the deleted replica.
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await expect(today(page)).toContainText(syncedNote, { timeout: 15_000 });
  await expect(today(page)).not.toContainText(unsyncedNote);
  expect(
    await page.evaluate(
      (id) =>
        (
          JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as {
            id: string;
            graphInstanceId?: string;
          }[]
        ).find((g) => g.id === id)?.graphInstanceId,
      entryId,
    ),
  ).not.toBe("an-earlier-graph-instance");

  // 7. The local-only graph's note is still there.
  await page.getByRole("button", { name: "Switch graph" }).click();
  await page.getByRole("button", { name: "This device", exact: true }).click();
  await expect(today(page)).toContainText(localNote, { timeout: 15_000 });
  expect(await hits(base, graphId, token, localNote)).toBe(0);
  await ctx.close();
});
