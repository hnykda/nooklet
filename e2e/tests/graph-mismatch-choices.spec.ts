/**
 * B-714: the "server has a different graph now" screen offers real choices. The discard (and its
 * B-631 guarantee) is `graph-mismatch-discard.spec.ts`; this file covers "keep this copy as a
 * device-only graph" (phone and a desktop-sized browser tab) and "open another graph".
 *
 * Set-up: `../helpers/graph-mismatch.ts` (emulated Capacitor shell for the phone; the plain
 * browser test is a loopback tab, which the server hands a token).
 */

import { expect, type Page, test } from "@playwright/test";
import {
  capacitorContext,
  connectFromSetup,
  createGraph,
  hits,
  MISMATCH_HEADING,
  marker,
  rememberAnEarlierGraph,
  today,
  typeToday,
  waitForWritesApplied,
} from "../helpers/graph-mismatch.js";
import { openGraphMenu } from "../helpers/index.js";

interface StoredEntry {
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  token?: string;
  graphInstanceId?: string;
  detachedFrom?: { replacedBy: string };
}

function storedGraphs(page: Page): Promise<{ active: string | null; graphs: StoredEntry[] }> {
  return page.evaluate(() => ({
    active: localStorage.getItem("nooklet.activeGraphId"),
    graphs: JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as StoredEntry[],
  }));
}

/** Records every sync request this page makes to `graphId` from now on. */
function watchSync(page: Page, graphId: string): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(`/g/${graphId}/sync/`)) seen.push(req.url());
  });
  return seen;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

/** `server`: the row that has an address (the copy, named after the same graph, has none). */
async function openSwitcherRow(page: Page, name: string, server = false): Promise<void> {
  await openGraphMenu(page);
  const rows = page.locator(".graph-switcher-name", { hasText: name });
  await (server ? rows.filter({ has: page.locator(".graph-switcher-address") }) : rows).click();
}

test("B-714 phone: keep the copy as a device-only graph, and the server's graph syncs fresh beside it", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(3 * 60_000);
  const base = baseURL as string;
  const graphId = `gk-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const syncedNote = marker("gksynced");
  const unsyncedNote = marker("gkunsynced");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  // A server graph with one synced note, then one note the server never sees.
  await page.goto(`${base}/journals`);
  await connectFromSetup(page, base, graphId, token);
  await typeToday(page, syncedNote);
  await expect.poll(() => hits(base, graphId, token, syncedNote), { timeout: 15_000 }).toBe(1);
  await page.route(`**/g/${graphId}/sync/**`, (route) => route.abort());
  await typeToday(page, unsyncedNote);
  await waitForWritesApplied(page);

  const entryId = await rememberAnEarlierGraph(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible();
  // Names the real address, counts what is at stake, and recommends keeping it.
  await expect(page.locator(".connect-lede")).toContainText(`/g/${graphId}`);
  await expect(page.getByTestId("mismatch-unsynced")).toContainText(/never reached a server/);
  await expect(page.getByText("Recommended")).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: test.info().outputPath("mismatch-phone.png") });
  // Taller than the phone: the last choice must still be reachable by scrolling (the app's `body`
  // does not scroll).
  const discard = page.getByRole("button", { name: "Discard the local copy and re-sync" });
  await page.locator(".graph-mismatch-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(discard).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("mismatch-phone-bottom.png") });

  // The B-633 hold is the screen's own job from here on.
  await page.unroute(`**/g/${graphId}/sync/**`);
  await page.getByRole("button", { name: "Keep as a device-only graph" }).click();

  // The server's graph: a new entry with the server's identity, synced fresh — its note, not the
  // copy's unsynced one.
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await expect(today(page)).toContainText(syncedNote, { timeout: 15_000 });
  await expect(today(page)).not.toContainText(unsyncedNote);
  const after = await storedGraphs(page);
  const copy = after.graphs.find((g) => g.id === entryId);
  const server = after.graphs.find((g) => g.id === after.active);
  expect(copy).toMatchObject({ kind: "local", graphInstanceId: "an-earlier-graph-instance" });
  expect(copy?.label).toMatch(/\(old copy\)$/);
  expect(copy?.baseUrl).toBeUndefined();
  expect(copy?.token).toBeUndefined();
  expect(server?.id).not.toBe(entryId);
  expect(server?.baseUrl).toBe(`${base}/g/${graphId}`);
  expect(server?.graphInstanceId).toBe(copy?.detachedFrom?.replacedBy);

  // The copy: every note intact after a reload, as a local-only graph, and it never syncs.
  const syncRequests = watchSync(page, graphId);
  await openSwitcherRow(page, "(old copy)");
  await expect(today(page)).toContainText(unsyncedNote, { timeout: 15_000 });
  await expect(today(page)).toContainText(syncedNote);
  await page.reload();
  await expect(today(page)).toContainText(unsyncedNote, { timeout: 15_000 });
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "local");
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toHaveCount(0);
  // A new edit in the copy stays in the copy.
  const copyNote = marker("gkcopy");
  await typeToday(page, copyNote);
  await waitForWritesApplied(page);
  await page.waitForTimeout(4_000);
  expect(syncRequests).toEqual([]);
  expect(await hits(base, graphId, token, unsyncedNote)).toBe(0);
  expect(await hits(base, graphId, token, copyNote)).toBe(0);

  // And back to the server's graph: still clean.
  await openSwitcherRow(page, graphId, true);
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await expect(today(page)).toContainText(syncedNote, { timeout: 15_000 });
  await expect(today(page)).not.toContainText(copyNote);
  await ctx.close();
});

test("B-714 browser tab: keep the copy without adding the server's graph", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(2 * 60_000);
  const base = baseURL as string;
  const graphId = `gw-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const syncedNote = marker("gwsynced");
  const unsyncedNote = marker("gwunsynced");
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();

  await page.goto(`${base}/g/${graphId}/journals`);
  await typeToday(page, syncedNote);
  await expect.poll(() => hits(base, graphId, token, syncedNote), { timeout: 15_000 }).toBe(1);
  await page.route(`**/g/${graphId}/sync/**`, (route) => route.abort());
  await typeToday(page, unsyncedNote);
  await waitForWritesApplied(page);
  const entryId = await rememberAnEarlierGraph(page);
  await page.unroute(`**/g/${graphId}/sync/**`);
  const syncRequests = watchSync(page, graphId);

  await page.reload();
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible();
  await expect(page.locator(".connect-lede")).toContainText(`/g/${graphId}`);
  await page.screenshot({ path: test.info().outputPath("mismatch-desktop.png"), fullPage: true });
  await page.getByLabel(/Also add the server's graph/).uncheck();
  await page.getByRole("button", { name: "Keep as a device-only graph" }).click();

  // Still under the server graph's `/g/<slug>`, but the copy is what opens, with its notes, local.
  await expect(today(page)).toContainText(unsyncedNote, { timeout: 15_000 });
  await expect(today(page)).toContainText(syncedNote);
  await page.reload();
  await expect(today(page)).toContainText(unsyncedNote, { timeout: 15_000 });
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "local");
  const after = await storedGraphs(page);
  expect(after.active).toBe(entryId);
  expect(after.graphs).toHaveLength(1);
  expect(after.graphs[0]?.token).toBeUndefined();
  await page.waitForTimeout(3_000);
  expect(syncRequests).toEqual([]);
  expect(await hits(base, graphId, token, unsyncedNote)).toBe(0);
  await ctx.close();
});

test("B-714: open another graph without deciding; the screen comes back for this one", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(3 * 60_000);
  const base = baseURL as string;
  const graphId = `gs-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const localNote = marker("gslocal");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  await typeToday(page, localNote);
  await waitForWritesApplied(page);
  await openGraphMenu(page);
  await page.getByText("Add a graph").click();
  await connectFromSetup(page, base, graphId, token);

  const entryId = await rememberAnEarlierGraph(page);
  const before = await storedGraphs(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible();
  await page.getByRole("button", { name: "Choose a graph" }).click();
  await page
    .getByRole("list", { name: "Other graphs on this device" })
    .getByRole("button")
    .first()
    .click();
  await expect(today(page)).toContainText(localNote, { timeout: 15_000 });

  // Nothing about the mismatched entry changed, and opening it shows the screen again.
  const after = await storedGraphs(page);
  expect(after.active).not.toBe(entryId);
  expect(after.graphs).toEqual(before.graphs);
  await openSwitcherRow(page, graphId, true);
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible({
    timeout: 15_000,
  });
  await ctx.close();
});
