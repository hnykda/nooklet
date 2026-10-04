/**
 * Shared set-up for the graph-mismatch specs (B-631, B-633, B-714): an emulated Capacitor shell,
 * so a local-only graph and server graphs can live side by side on one device, and a mismatch made
 * the way it happens in life, from the client's side: the entry remembers a different graph
 * identity than the server now reports.
 *
 * `/api/session` answers with no token (a phone is not a loopback client) but with the graph's real
 * identity, so the mismatch check runs for real.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

function rootToken(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return readFileSync(join(state.dataDir, "root.token"), "utf8").trim();
}

/** A new graph on the e2e server; returns a device token for it. */
export async function createGraph(base: string, id: string): Promise<string> {
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id, label: id }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** How many blocks in the server's graph contain `text`. */
export async function hits(
  base: string,
  graphId: string,
  token: string,
  text: string,
): Promise<number> {
  const res = await fetch(`${base}/g/${graphId}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: text, mode: "keyword" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hits: unknown[] }).hits.length;
}

export async function capacitorContext(browser: Browser, base: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
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

export const today = (page: Page) => page.locator(".journal-day-today").first();

export function marker(tag: string): string {
  return `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Type one line into today: the draft on an empty day, else a new last block. */
export async function typeToday(page: Page, text: string): Promise<void> {
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
export async function waitForWritesApplied(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied-ops")).length,
      ),
    )
    .toBe(0);
}

/** Connects this (emulated) phone to `graphId` from the set-up screen or the switcher. */
export async function connectFromSetup(
  page: Page,
  base: string,
  graphId: string,
  token: string,
): Promise<void> {
  await page.getByRole("button", { name: /Sync with a server/s }).click();
  await page.getByLabel("Server address").fill(`${base}/g/${graphId}`);
  await page.getByLabel("Device token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
}

/** The mismatch: the active entry remembers a different graph than the server now reports.
 * Returns the entry's id. */
export async function rememberAnEarlierGraph(page: Page): Promise<string> {
  return page.evaluate(() => {
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
}

export const MISMATCH_HEADING = "The server has a different graph now";
