/**
 * Local-only graphs under ADR 025, on an emulated Capacitor shell (B-611, B-612, B-619;
 * `docs/progress/local-graphs.md`).
 *
 * Emulation: `window.Capacitor` stubbed before any app code, so `platform.name === "capacitor"`
 * and the Capacitor-only paths run ("Just this device", the add-graph choice, the checkpoint), and
 * `/api/session` answers with no token for every graph, as it does for a phone (a non-loopback
 * client). The shell is served at `/journals` with NO `/g/<slug>` prefix — what a bundle at
 * `capacitor://localhost` looks like to the app; under a prefix the app would adopt that path's
 * graph on first launch, which a phone never does — by fulfilling that navigation with the
 * server's own `index.html`. No service worker, as in the real shell.
 * `tools/probes/sweep-devices/local-then-server.probe.ts` runs the same flows with the shell on a
 * separate static origin.
 *
 * Server-side claims are checked with Node's `fetch` against the server graph directly, never
 * through the page.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { openGraphMenu } from "../helpers/index.js";

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
  // A phone is not a loopback client: the server hands it no token, for any graph.
  await ctx.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  return ctx;
}

/** Blocks the replica's worker for `ms`, the shape of a long SQLite call (as in
 * `reload-durability.spec.ts`). Never awaited: a reload ends the worker first. */
function occupyReplica(page: Page, ms: number): void {
  const worker = page.workers().find((w) => w.url().includes("db.worker"));
  if (!worker) throw new Error(`no db worker among ${page.workers().map((w) => w.url())}`);
  void worker
    .evaluate((duration) => {
      const end = Date.now() + duration;
      while (Date.now() < end) {
        // busy
      }
    }, ms)
    .catch(() => {});
}

const today = (page: Page) => page.locator(".journal-day-today").first();

/** Unique, single-token search words: the server's keyword search finds them exactly. */
function marker(tag: string): string {
  return `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

test("B-611/B-612: local-only notes never reach a server graph added right after, and stay reachable (20 runs)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(20 * 60_000);
  const base = baseURL as string;
  const runs = Number(process.env.LOCAL_GRAPHS_RUNS ?? 20);
  let leaks = 0;
  for (let i = 0; i < runs; i++) {
    const graphId = `lg-${Date.now().toString(36)}-${i}`;
    const token = await createGraph(base, graphId);
    const noteA = marker("lgnotea");
    const noteB = marker("lgnoteb");
    const ctx = await capacitorContext(browser, base);
    const page = await ctx.newPage();

    // 1. "Just this device", a note through today's draft.
    await page.goto(`${base}/journals`);
    await page.getByRole("button", { name: /Just this device/s }).click();
    const draft = today(page).locator(".vr-draft-input");
    await expect(draft).toBeVisible();
    await draft.fill(noteA);
    await page.keyboard.press("Enter");
    await expect(
      today(page).locator(".vr-row:not(.vr-row-draft)", { hasText: noteA }),
    ).toBeVisible();

    // 2. A second note handed to a busy worker, then an immediate relaunch: its batch is orphaned
    //    (the B-247 copy is all there is of it).
    await page.waitForTimeout(800);
    occupyReplica(page, 4_000);
    await page.keyboard.type(noteB, { delay: 10 });
    await page.waitForTimeout(1_200); // past the 500 ms text debounce: posted, still queued
    const orphaned = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied-ops")).length,
    );
    expect(orphaned, "the relaunch must happen with a batch still unapplied").toBeGreaterThan(0);
    await page.reload();

    // 3. Straight to "Add a graph" on the relaunched page: no set-up screen any more (B-612).
    await expect(page.locator(".connect")).toHaveCount(0);
    await openGraphMenu(page);
    await page.getByText("Add a graph").click();
    await page.getByRole("button", { name: /Sync with a server/s }).click();
    await page.getByLabel("Server address").fill(`${base}/g/${graphId}`);
    await page.getByLabel("Device token").fill(token);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    // Past the second replay pass (+5 s) of every page load in this run.
    await page.waitForTimeout(6_000);
    const leaked =
      (await hits(base, graphId, token, noteA)) + (await hits(base, graphId, token, noteB));
    if (leaked > 0) leaks++;

    // 4. The local-only graph is still listed, and both notes are in it.
    await openGraphMenu(page);
    const rows = page.locator(".graph-switcher-row");
    await expect(rows).toHaveCount(2);
    // B-644: the local graph has a generated name now; it is the row with no server address.
    await rows
      .filter({ hasNot: page.locator(".graph-switcher-address") })
      .locator(".graph-switcher-name")
      .click();
    await expect(today(page)).toContainText(noteA, { timeout: 15_000 });
    await expect(today(page)).toContainText(noteB, { timeout: 15_000 });
    await ctx.close();
  }
  expect(leaks, `runs where a local-only note reached the server graph, of ${runs}`).toBe(0);
});

test("B-611: an unscoped batch from an older build is not replayed into a server graph (deterministic)", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  const graphId = `lg-seed-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const note = marker("lgseeded");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();
  await page.goto(`${base}/journals`);

  // Exactly what the sweep saw: an orphaned v1 batch (no graph in its key) written by a
  // "Just this device" page load, then a server graph added and made active.
  await page.evaluate(
    ({ note, graphUrl, token }) => {
      const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
      const id = () =>
        Array.from({ length: 14 }, () => alphabet[Math.floor(Math.random() * 32)]).join("");
      const hlc = (n: number) => `${new Date(Date.now() - 60_000).toISOString()}-000${n}-lgdev001`;
      const pageId = id();
      const ops = [
        {
          id: hlc(0),
          hlc: hlc(0),
          device: "lgdev001",
          entity: pageId,
          payload: { kind: "page.create", name: `Seeded ${note}`, journalDay: null, createdAt: 1 },
        },
        {
          id: hlc(1),
          hlc: hlc(1),
          device: "lgdev001",
          entity: id(),
          payload: {
            kind: "block.create",
            place: { pageId, parentId: null, order: "a0" },
            content: note,
            createdAt: 1,
          },
        },
      ];
      localStorage.clear();
      localStorage.setItem(
        "nooklet.unapplied-ops.v1:dead-local-load:00000000",
        JSON.stringify({ at: 1, ops }),
      );
      localStorage.setItem(
        "nooklet.graphs",
        JSON.stringify([
          { id: "srv", label: "Remote graph", kind: "remote", baseUrl: graphUrl, token },
        ]),
      );
      localStorage.setItem("nooklet.activeGraphId", "srv");
    },
    { note, graphUrl: `${base}/g/${graphId}`, token },
  );
  await page.goto(`${base}/journals`);
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await page.waitForTimeout(7_000); // both replay passes
  expect(await hits(base, graphId, token, note)).toBe(0);
  // Kept aside, not dropped.
  const quarantined = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied-ops.quarantine.v1:")),
  );
  expect(quarantined).toEqual(["nooklet.unapplied-ops.quarantine.v1:dead-local-load:00000000"]);
  await ctx.close();
});

test('B-612: an install stranded by the old "Just this device" gets its local graph back in the list', async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  const graphId = `lg-strand-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const note = marker("lgstranded");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  // The old behaviour, rebuilt: a local-only note in the un-namespaced replica with NO list
  // entry (what "Just this device" used to leave), then a server entry, active.
  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  const draft = today(page).locator(".vr-draft-input");
  await draft.fill(note);
  await page.keyboard.press("Enter");
  await expect(today(page).locator(".vr-row:not(.vr-row-draft)", { hasText: note })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.evaluate(
    ({ graphUrl, token }) => {
      localStorage.removeItem("nooklet.legacyReplicaAdopted");
      localStorage.setItem(
        "nooklet.graphs",
        JSON.stringify([
          { id: "srv", label: "Remote graph", kind: "remote", baseUrl: graphUrl, token },
        ]),
      );
      localStorage.setItem("nooklet.activeGraphId", "srv");
    },
    { graphUrl: `${base}/g/${graphId}`, token },
  );
  await page.reload();
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });

  await openGraphMenu(page);
  await page.getByRole("button", { name: "This device", exact: true }).click();
  await expect(today(page)).toContainText(note, { timeout: 15_000 });
  expect(await hits(base, graphId, token, note)).toBe(0);
  await ctx.close();
});

test("B-619: a draft line closed while the worker is busy survives an immediate relaunch (5 runs)", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  test.setTimeout(5 * 60_000);
  for (let i = 0; i < 5; i++) {
    const note = marker("lgdraft");
    const ctx = await capacitorContext(browser, base);
    const page = await ctx.newPage();
    await page.goto(`${base}/journals`);
    await page.getByRole("button", { name: /Just this device/s }).click();
    const draft = today(page).locator(".vr-draft-input");
    await expect(draft).toBeVisible();
    await page.waitForTimeout(500);
    // The draft's commit needs the worker (template + HLC pool) before it has any op to write.
    occupyReplica(page, 3_000);
    await draft.fill(note);
    await page.keyboard.press("Enter");
    // Proof the window was hit: shown as a closed draft line, not yet a block of the day.
    await expect(today(page).locator(".vr-draft-line", { hasText: note })).toBeVisible();
    await page.reload();
    await expect(today(page)).toContainText(note, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(today(page)).toContainText(note, { timeout: 15_000 });
    await ctx.close();
  }
});
