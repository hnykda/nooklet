/**
 * B-643/B-644: a local graph from the graph switcher, on the desktop app (emulated shell) and on
 * the phone (emulated Capacitor, phone viewport). `docs/progress/desktop-local-graph.md`.
 *
 * Desktop emulation: `window.__NOOKLET_DESKTOP__` injected before any page script, as
 * `main.rs#shell_script` does. The shell's own half (intercepting the request navigation, running
 * `nooklet graph create`, restarting) is Rust and covered by `cargo test`; here the request is
 * caught with `page.route` and the shell's effect is rebuilt by hand: the graph is created on the
 * server, and the page lands on `/g/<id>` the way the launcher opens it. Chromium, not WKWebView:
 * that `on_navigation` really sees `location.assign` in the app's window is unverified here.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { GRAPH_NAMES } from "../../apps/web/src/data/graph-names.js";

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

async function injectShell(
  page: Page,
  port: number,
  localGraphs: { id: string; label: string }[],
): Promise<void> {
  await page.addInitScript(
    ([p, graphs]) => {
      Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
        value: Object.freeze({
          platform: "macos",
          port: p,
          graphs: [],
          activeGraphId: null,
          localGraphs: graphs,
          activeLocalGraph: null,
          forcePicker: false,
        }),
      });
    },
    [port, localGraphs] as const,
  );
}

/** What a shell request asked for, caught before it leaves the browser. */
async function catchShellRequests(page: Page): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route("http://nooklet-desktop.invalid/**", (route) => {
    seen.push(new URL(route.request().url()));
    return route.fulfill({ contentType: "text/html", body: "<title>shell request</title>" });
  });
  return seen;
}

test.describe("desktop app", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("B-643: in remote mode the switcher offers a new graph on this Mac and lists This Mac's graphs", async ({
    page,
  }) => {
    // The page is "a remote server" to the shell: its bundled server is on another port.
    await injectShell(page, 6100, [
      { id: "default", label: "default" },
      { id: "quiet-otter", label: "Quiet Otter" },
    ]);
    const requests = await catchShellRequests(page);
    await page.goto("/journals");
    await expect(page.locator(".app-topbar")).toBeVisible();

    await page.getByRole("button", { name: "Switch graph" }).click();
    const mac = page.getByRole("list", { name: "On this Mac" });
    await expect(mac.getByRole("button")).toHaveText([/This Mac/, /Quiet Otter/]);

    await page.getByRole("button", { name: "Add a graph" }).click();
    await expect(page.getByText("Sync with a server")).toBeVisible();
    await page.getByRole("button", { name: /New graph on this Mac/ }).click();
    await expect.poll(() => requests.length).toBe(1);
    const request = requests[0] as URL;
    expect(request.pathname).toBe("/new-local-graph");
    const label = request.searchParams.get("label");
    expect(GRAPH_NAMES).toContain(label);
    expect(label).not.toBe("Quiet Otter");
  });

  test("B-643: picking a This-Mac graph from a remote server's page asks the shell to open it", async ({
    page,
  }) => {
    await injectShell(page, 6100, [{ id: "quiet-otter", label: "Quiet Otter" }]);
    const requests = await catchShellRequests(page);
    await page.goto("/journals");
    await page.getByRole("button", { name: "Switch graph" }).click();
    await page.getByRole("list", { name: "On this Mac" }).getByRole("button").click();
    await expect
      .poll(() => requests.map((u) => u.toString()))
      .toEqual(["http://nooklet-desktop.invalid/open-local-graph?id=quiet-otter"]);
  });

  test("B-643: once made, the new graph opens on This Mac's server and is listed by its name", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    const label = GRAPH_NAMES[GRAPH_NAMES.length - 1] as string;
    const id = `${label.toLowerCase().replace(/ /g, "-")}-${Date.now().toString(36)}`;
    // What the shell does for "new-local-graph": make the graph on its own server...
    await createGraph(base, id, label);
    // ...on a page that is This Mac's own server (the shell's port is this server's).
    await injectShell(page, port, [
      { id: "default", label: "default" },
      { id, label },
    ]);
    // This origin has used its default graph before, which is the active entry.
    await page.goto("/g/default/journals");
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });

    // ...then the restarted launcher opens `/g/<id>` (`launcher/index.html#LOCAL_GRAPH_PATH`).
    const apiPaths: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (/\/api\/|\/sync\//.test(path)) apiPaths.push(path);
    });
    await page.goto(`/g/${id}`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    // Every request goes to the graph in the address bar, none to the previously active one.
    expect(apiPaths.length).toBeGreaterThan(0);
    expect(apiPaths.filter((p) => !p.startsWith(`/g/${id}/`))).toEqual([]);

    await page.getByRole("button", { name: "Switch graph" }).click();
    const active = page.locator(".graph-switcher-row.active");
    await expect(active).toContainText(label, { timeout: 10_000 });
    await expect(page.locator(".graph-switcher-row")).toHaveCount(2);
    // Both This-Mac graphs are rows already, so there is no separate "On this Mac" group.
    await expect(page.getByRole("list", { name: "On this Mac" })).toHaveCount(0);
  });
});

async function phoneContext(browser: Browser, base: string): Promise<BrowserContext> {
  // As `local-graphs.spec.ts#capacitorContext`: the shell with no `/g/` prefix, Capacitor stubbed.
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
  await ctx.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  return ctx;
}

test("B-644: on the phone, new local graphs get distinct friendly names, and can still be renamed", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  const ctx = await phoneContext(browser, base);
  const page = await ctx.newPage();
  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  await expect(page.locator(".app-topbar")).toBeVisible();

  await page.getByRole("button", { name: "Switch graph" }).click();
  await page.getByRole("button", { name: "Add a graph" }).click();
  await page.getByRole("button", { name: /Just this device/ }).click();
  await expect(page.locator(".app-topbar")).toBeVisible();

  await page.getByRole("button", { name: "Switch graph" }).click();
  const labels = page.locator(".graph-switcher-row .graph-switcher-label");
  await expect(labels).toHaveCount(2);
  const names = await labels.allTextContents();
  for (const name of names) expect(GRAPH_NAMES).toContain(name);
  expect(new Set(names).size).toBe(2);
  expect(names).not.toContain("This device");

  const first = names[0] as string;
  await page.getByRole("button", { name: `Rename ${first}` }).click();
  await page.locator(".graph-switcher-rename-input").fill("Holiday notes");
  await page.keyboard.press("Enter");
  await expect(labels).toHaveText(["Holiday notes", names[1] as string]);
  await ctx.close();
});
