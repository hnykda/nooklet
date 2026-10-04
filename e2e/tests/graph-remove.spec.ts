/**
 * B-712: removing a graph from a device is never one tap. Real server, real replicas:
 *
 * - a server graph with changes this device never pushed: the dialog says how many, and "Remove"
 *   stays disabled until `delete` is typed; with nothing unsynced it is a plain confirm;
 * - the desktop app (shell emulated as in `desktop-graphs.spec.ts`): only a server graph can be
 *   removed there, through the shell (ADR 032);
 * - the phone's local-only graph (Capacitor emulated, phone viewport with touch): the "only copy"
 *   wording, typed confirm. Runs in WebKit too.
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

async function createGraph(base: string, id: string, label: string): Promise<void> {
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id, label }),
  });
  expect(res.status).toBe(201);
}

/** This page's list entry for `/g/<slug>`, by address. */
async function entryId(page: Page, slug: string): Promise<string> {
  return page.evaluate((s) => {
    const graphs = JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as Array<{
      id: string;
      baseUrl?: string;
    }>;
    const found = graphs.find((g) => g.baseUrl?.replace(/\/+$/, "").endsWith(`/g/${s}`));
    if (!found) throw new Error(`no entry for ${s}`);
    return found.id;
  }, slug);
}

async function memo(page: Page, id: string): Promise<number | null> {
  return page.evaluate((i) => {
    const raw = localStorage.getItem(`nooklet.pendingCount.${i}`);
    return raw === null ? null : Number(raw);
  }, id);
}

const suffix = Date.now().toString(36);

test.describe("desktop browser", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  // WebKit's build has no OPFS in workers (playwright.config.ts): its replica is in-memory, never
  // "synced", so these server-graph cases are Chromium's. The phone case below runs in both.
  test.skip(({ browserName }) => browserName === "webkit", "no OPFS replica in Playwright WebKit");

  test("B-712: a server graph with unsynced changes says how many are lost and needs 'delete' typed", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const slug = `rm-pending-${suffix}`;
    await createGraph(base, slug, "Pending Graph");
    // Nothing this device writes to that graph reaches the server.
    await page.route(`**/g/${slug}/sync/push`, (route) => route.abort());
    await page.goto(`/g/${slug}/journals`);
    const draft = page.locator(".journal-day-today .vr-draft-input").first();
    await expect(draft).toBeVisible({ timeout: 20_000 });
    await draft.fill("written here, never pushed");
    await page.keyboard.press("Enter");
    await page.keyboard.type("and a second line");
    await page.keyboard.press("Escape");
    const id = await entryId(page, slug);
    await expect.poll(() => memo(page, id), { timeout: 15_000 }).toBeGreaterThan(0);

    // Open another graph; the one with unsynced changes is now removable.
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page.getByRole("button", { name: "Remove Pending Graph" }).click();
    const dialog = page.getByRole("alertdialog");
    // The count the sync engine last reported for that graph on this device (more ops may have
    // been queued after the poll above saw the first one).
    const pending = (await memo(page, id)) as number;
    expect(pending).toBeGreaterThan(0);
    await expect(dialog).toContainText(
      `${pending} ${pending === 1 ? "change" : "changes"} made on this device`,
    );
    await expect(dialog).toContainText("not reached the server yet and will be lost");
    await expect(dialog).toContainText("keeps “Pending Graph”");
    const remove = dialog.getByRole("button", { name: "Remove" });
    await expect(remove).toBeDisabled();
    const field = dialog.getByRole("textbox");
    await field.fill("delet");
    await expect(remove).toBeDisabled();
    await field.fill("delete");
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(dialog).toHaveCount(0);
    const menu = page.getByRole("dialog", { name: "Switch graph" });
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("Pending Graph");
  });

  test("B-712: a server graph with nothing unsynced is a plain confirm", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const slug = `rm-clean-${suffix}`;
    await createGraph(base, slug, "Clean Graph");
    await page.goto(`/g/${slug}/journals`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    const id = await entryId(page, slug);
    await expect.poll(() => memo(page, id)).toBe(0);

    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page.getByRole("button", { name: "Remove Clean Graph" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("other devices are unaffected");
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("dialog", { name: "Switch graph" })).not.toContainText(
      "Clean Graph",
    );
  });

  test("B-781: in the desktop app only a server graph is removable, and the shell does it", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    const mac = (id: string, label: string) => ({
      key: `mac:${id}`,
      place: "mac",
      id,
      label,
      address: `${base}/g/${id}`,
    });
    const server = {
      key: "server:s1",
      place: "server",
      id: "s1",
      label: "Far Graph",
      address: "https://notes.example.com/g/far",
    };
    await page.addInitScript(
      ([p, graphs]) => {
        Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
          value: Object.freeze({ platform: "macos", port: p, key: "k", graphs, graphToken: null }),
        });
      },
      [port, [mac("default", "This Mac"), mac(`rm-mac-${suffix}`, "Mac Graph"), server]] as const,
    );
    // What the page asks the shell, held back as the shell would (`main.rs` cancels it).
    const asked: URL[] = [];
    await page.route("http://nooklet-desktop.invalid/**", (route) => {
      asked.push(new URL(route.request().url()));
      return route.abort("aborted");
    });
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    const menu = page.getByRole("dialog", { name: "Graphs" });
    // This Mac's graphs are folders on disk: not removable from here.
    await expect(menu.getByRole("button", { name: "Remove Mac Graph" })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Remove This Mac" })).toHaveCount(0);
    await menu.getByRole("button", { name: "Remove Far Graph" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("keeps the graph");
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => asked.map((u) => u.pathname)).toEqual(["/remove"]);
    const request = asked[0] as URL;
    expect(request.searchParams.get("graph")).toBe("server:s1");
    expect(request.searchParams.get("key")).toBe("k");
    // The shell's answer (`main.rs#reply`): the list without it.
    await page.evaluate(
      ([req, graphs]) =>
        window.dispatchEvent(
          new CustomEvent("nooklet:desktop-reply", { detail: { req, ok: true, graphs } }),
        ),
      [request.searchParams.get("req"), [mac("default", "This Mac")]] as const,
    );
    await expect(menu).not.toContainText("Far Graph");
  });
});

async function phoneContext(browser: Browser, base: string): Promise<BrowserContext> {
  // As `desktop-graphs.spec.ts#phoneContext`: the app shell with no `/g/` prefix, Capacitor
  // stubbed, a phone's viewport and touch.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
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
  await ctx.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  return ctx;
}

test("B-712: on the phone a local-only graph is called the only copy and needs 'delete' typed", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  const ctx = await phoneContext(browser, base);
  const page = await ctx.newPage();
  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  await expect(page.locator(".app-topbar")).toBeVisible();
  const first = await page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as { label: string }[])[0]?.label,
  );
  // A second local graph, which becomes the open one.
  await openGraphMenu(page);
  await page.getByRole("button", { name: "Add a graph" }).click();
  await page.getByRole("button", { name: /Just this device/ }).click();
  await expect(page.locator(".app-topbar")).toBeVisible();

  await openGraphMenu(page);
  await page.getByRole("button", { name: `Remove ${first}` }).tap();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`This device holds the only copy of “${first}”`);
  await expect(dialog).toContainText("cannot be undone");
  await expect(dialog).toContainText("cannot export a whole graph yet");
  const go = dialog.getByRole("button", { name: "Delete forever" });
  await expect(go).toBeDisabled();
  // Cancel keeps it.
  await dialog.getByRole("button", { name: "Cancel" }).tap();
  await expect(dialog).toHaveCount(0);
  const menu = page.getByRole("dialog", { name: "Switch graph" });
  await expect(menu).toContainText(first as string);

  await page.getByRole("button", { name: `Remove ${first}` }).tap();
  await dialog.getByRole("textbox").fill("delete");
  await expect(go).toBeEnabled();
  await go.tap();
  await expect(dialog).toHaveCount(0);
  await expect(menu.locator(".graph-switcher-row")).toHaveCount(1);
  await expect(menu).not.toContainText(first as string);
  await ctx.close();
});
