/**
 * Proposal 005 / ADR 032 (B-780..B-785): graphs in the desktop app, page side, with the shell
 * emulated; and B-644 on the phone (emulated Capacitor, phone viewport).
 *
 * Desktop emulation: `window.__NOOKLET_DESKTOP__` injected before any page script, in the shape
 * `main.rs#shell_script` gives it (the shell's graph list, the request key, and — only in that
 * graph's documents — its token). The shell's own half is Rust and covered by `cargo test`: the
 * list and its migration, the token check against a server, the keychain, which documents get the
 * token, which navigation needs a new window. Here a request to the shell is caught with
 * `page.route` and aborted (the shell cancels it the same way), and its answer is the
 * `nooklet:desktop-reply` event `main.rs#reply` evaluates. Chromium, not WKWebView: that
 * `on_navigation` sees these navigations in the app's real window is the owner's check.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { GRAPH_NAMES } from "../../apps/web/src/data/graph-names.js";
import { openGraphMenu } from "../helpers/index.js";

function rootToken(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return readFileSync(join(state.dataDir, "root.token"), "utf8").trim();
}

/** A graph on the e2e server; returns a device token for it. */
async function createGraph(base: string, id: string, label: string): Promise<string> {
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id, label }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

interface Graph {
  key: string;
  place: "mac" | "server";
  id: string;
  label: string;
  address: string;
}

const mac = (port: number, id: string, label: string): Graph => ({
  key: `mac:${id}`,
  place: "mac",
  id,
  label,
  address: `http://127.0.0.1:${port}/g/${id}`,
});

const server = (id: string, label: string, address: string): Graph => ({
  key: `server:${id}`,
  place: "server",
  id,
  label,
  address,
});

async function injectShell(
  page: Page,
  port: number,
  graphs: Graph[],
  graphToken: string | null = null,
  flags: { deleteMac?: boolean; listServerGraphs?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ([p, g, t, f]) => {
      Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
        value: Object.freeze({
          platform: "macos",
          port: p,
          downloads: true,
          key: "window-key",
          graphs: g,
          graphToken: t,
          ...f,
        }),
      });
    },
    [port, graphs, graphToken, flags] as const,
  );
}

/** What the page asked the shell, caught and held back as `main.rs#on_navigation` does. */
async function catchShellRequests(page: Page): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route("http://nooklet-desktop.invalid/**", (route) => {
    seen.push(new URL(route.request().url()));
    return route.abort("aborted");
  });
  return seen;
}

/** The shell's answer to `request` (`main.rs#reply`). */
async function reply(page: Page, request: URL, detail: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([req, d]) =>
      window.dispatchEvent(new CustomEvent("nooklet:desktop-reply", { detail: { req, ...d } })),
    [request.searchParams.get("req"), detail] as const,
  );
}

/** As a remote server's page: the server hands this window no token (it is not loopback). */
async function asRemoteServer(page: Page): Promise<void> {
  await page.route("**/api/session", async (route) => {
    const real = await route.fetch();
    const body = (await real.json()) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, token: null, reason: "non_loopback_host" }),
    });
  });
}

test.describe("desktop app", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("B-781: the menu lists the shell's graphs (On this Mac / On servers), the same from any page", async ({
    page,
    baseURL,
  }) => {
    const port = Number(new URL(baseURL as string).port);
    await injectShell(page, port, [
      mac(port, "default", "This Mac"),
      mac(port, "quiet-otter", "Quiet Otter"),
      server("s1", "Work", "https://notes.example.com/g/work"),
    ]);
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    const menu = page.getByRole("dialog", { name: "Graphs" });
    await expect(
      menu.getByRole("list", { name: "On this Mac" }).locator(".graph-switcher-label"),
    ).toHaveText(["This Mac", "Quiet Otter"]);
    await expect(menu.getByRole("list", { name: "On servers: notes.example.com" })).toContainText(
      "Work",
    );
    await expect(menu.locator("[aria-current='true']")).toContainText("This Mac");
    // B-783: no phone words on desktop.
    await expect(menu).not.toContainText(/device|Just this|On a server/i);
  });

  test("B-785: picking a graph navigates the window to its address, which the shell routes", async ({
    page,
    baseURL,
  }) => {
    const port = Number(new URL(baseURL as string).port);
    await injectShell(page, port, [
      mac(port, "default", "This Mac"),
      server("s1", "Work", "https://notes.example.com/g/work"),
    ]);
    const asked: string[] = [];
    await page.route("https://notes.example.com/**", (route) => {
      asked.push(route.request().url());
      return route.abort("aborted");
    });
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page
      .getByRole("dialog", { name: "Graphs" })
      .getByRole("button", { name: /^Work/ })
      .click();
    await expect.poll(() => asked).toEqual(["https://notes.example.com/g/work"]);
  });

  test("B-782: Add a graph → Create on this Mac asks the shell with the window key; a failure is shown on the form", async ({
    page,
    baseURL,
  }) => {
    const port = Number(new URL(baseURL as string).port);
    await injectShell(page, port, [
      mac(port, "default", "This Mac"),
      mac(port, "quiet-otter", "Quiet Otter"),
    ]);
    const requests = await catchShellRequests(page);
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page.getByRole("button", { name: "Add a graph" }).click();
    const create = page.getByRole("region", { name: "Create on this Mac" });
    const name = await create.getByLabel("Name").inputValue();
    expect(GRAPH_NAMES).toContain(name);
    expect(name).not.toBe("Quiet Otter");
    await create.getByRole("button", { name: "Create" }).click();
    await expect.poll(() => requests.length).toBe(1);
    const request = requests[0] as URL;
    expect(request.pathname).toBe("/new-local-graph");
    expect(request.searchParams.get("label")).toBe(name);
    expect(request.searchParams.get("key")).toBe("window-key");
    await reply(page, request, { ok: false, error: "graph create failed: disk full" });
    await expect(create.getByRole("alert")).toHaveText("graph create failed: disk full");
  });

  test("B-782: Connect to a server is one form: the address and token go to the shell together, errors come back to it", async ({
    page,
    baseURL,
  }) => {
    const port = Number(new URL(baseURL as string).port);
    await injectShell(page, port, [mac(port, "default", "This Mac")]);
    const requests = await catchShellRequests(page);
    const elsewhere = "http://127.0.0.1:6549";
    const contacted: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(elsewhere)) contacted.push(r.url());
    });
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page.getByRole("button", { name: "Add a graph" }).click();
    const connect = page.getByRole("region", { name: "Connect to a server" });
    await connect.getByLabel("Server address").fill(`${elsewhere}/g/work`);
    // A wrong shape is named here, before anything is sent (B-706).
    await connect.getByLabel("Device token or pairing link").fill("nk_short");
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect.getByRole("alert")).toContainText("should start with nk_");
    expect(requests).toEqual([]);

    const token = `nk_${"ab".repeat(24)}`;
    await connect.getByLabel("Device token or pairing link").fill(token);
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => requests.length).toBe(1);
    const request = requests[0] as URL;
    expect(request.pathname).toBe("/connect-server");
    expect(request.searchParams.get("address")).toBe(`${elsewhere}/g/work`);
    expect(request.searchParams.get("token")).toBe(token);
    await expect(connect.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    // The shell could not reach it: said on this same form, which is still filled in.
    await reply(page, request, {
      ok: false,
      error: "Couldn't reach 127.0.0.1:6549: Connection refused",
    });
    await expect(connect.getByRole("alert")).toHaveText(
      "Couldn't reach 127.0.0.1:6549: Connection refused",
    );
    await expect(connect.getByLabel("Server address")).toHaveValue(`${elsewhere}/g/work`);
    // The page itself never contacted the server (cross-origin, B-704).
    expect(contacted).toEqual([]);
  });

  test("ADR 032: a server graph's page starts authenticated with the token the shell hands it, and stores none", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const id = `desk-${Date.now().toString(36)}`;
    const token = await createGraph(base, id, "Desk Graph");
    // The shell's own server is elsewhere (6100): to this page, this server is a remote one.
    await injectShell(
      page,
      6100,
      [mac(6100, "default", "This Mac"), server("s1", "Desk Graph", `${base}/g/${id}`)],
      token,
    );
    await asRemoteServer(page);
    await page.goto(`/g/${id}/journals`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(page.getByRole("button", { name: "Desk Graph, switch graph" })).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toContain(token);
  });

  test("B-782: a server graph with no token yet opens on the add form, pre-filled, with a way to another graph", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const id = `notok-${Date.now().toString(36)}`;
    await createGraph(base, id, "No Token Yet");
    await injectShell(page, 6100, [
      mac(6100, "default", "This Mac"),
      server("s1", "No Token Yet", `${base}/g/${id}`),
    ]);
    await asRemoteServer(page);
    // What an older version left in this origin's storage: the token it used for this graph.
    const legacy = `nk_${"cd".repeat(24)}`;
    await page.addInitScript(
      ([graphId, t]) => {
        if (localStorage.getItem("nooklet.graphs")) return;
        localStorage.setItem(
          "nooklet.graphs",
          JSON.stringify([
            { id: "old", label: "x", kind: "local", baseUrl: `/g/${graphId}`, token: t },
          ]),
        );
        localStorage.setItem("nooklet.activeGraphId", "old");
      },
      [id, legacy] as const,
    );
    const requests = await catchShellRequests(page);
    const elsewhere: string[] = [];
    await page.route("http://127.0.0.1:6100/**", (route) => {
      elsewhere.push(route.request().url());
      return route.abort("aborted");
    });
    await page.goto(`/g/${id}/journals`);
    await expect(page.getByRole("heading", { name: "Connect to No Token Yet" })).toBeVisible();
    // No phone choices: not "Just this device", not a token-only field (B-783).
    await expect(page.getByText(/Just this device|Set up this device/)).toHaveCount(0);
    const connect = page.getByRole("region", { name: "Connect to a server" });
    await expect(connect.getByLabel("Server address")).toHaveValue(`${base}/g/${id}`);
    await expect(connect.getByLabel("Device token or pairing link")).toHaveValue(legacy);
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => requests.map((u) => u.pathname)).toEqual(["/connect-server"]);
    expect(requests[0]?.searchParams.get("token")).toBe(legacy);
    await reply(page, requests[0] as URL, {
      ok: false,
      error: "That token was rejected. Check it was copied whole, and not revoked.",
    });
    await expect(connect.getByRole("alert")).toContainText("rejected");

    const others = page.getByRole("region", { name: "Open another graph instead" });
    await others.getByRole("button", { name: /This Mac/ }).click();
    await expect.poll(() => elsewhere).toEqual(["http://127.0.0.1:6100/g/default"]);
  });

  test("B-643: a graph made on This Mac opens there and is listed by its name, open", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    const label = GRAPH_NAMES[GRAPH_NAMES.length - 1] as string;
    const id = `${label.toLowerCase().replace(/ /g, "-")}-${Date.now().toString(36)}`;
    // What the shell does for "new-local-graph": make the graph on its own server, then open a
    // window on it whose list includes it.
    await createGraph(base, id, label);
    await injectShell(page, port, [mac(port, "default", "This Mac"), mac(port, id, label)]);
    const apiPaths: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (/\/api\/|\/sync\//.test(path)) apiPaths.push(path);
    });
    await page.goto(`/g/${id}`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    expect(apiPaths.filter((p) => !p.startsWith(`/g/${id}/`))).toEqual([]);
    await openGraphMenu(page);
    const list = page.getByRole("list", { name: "On this Mac" });
    await expect(list.locator("[aria-current='true']")).toContainText(label);
    await expect(page.getByRole("list", { name: /On servers/ })).toHaveCount(0);
  });

  test("B-786: a graph on This Mac is deleted only with 'delete' typed, and only from the bundled server's own page", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    const id = `trash-${Date.now().toString(36)}`;
    await createGraph(base, id, "Garden Shed");
    const graphs = [mac(port, "default", "This Mac"), mac(port, id, "Garden Shed")];
    await injectShell(page, port, graphs, null, { deleteMac: true });
    const requests = await catchShellRequests(page);
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    const menu = page.getByRole("dialog", { name: "Graphs" });
    // Not This Mac's main graph, which is also the open one.
    await expect(menu.getByRole("button", { name: "Delete This Mac" })).toHaveCount(0);
    await menu.getByRole("button", { name: "Delete Garden Shed" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("only copy");
    await expect(dialog).toContainText("moved to the Trash, not erased");
    const go = dialog.getByRole("button", { name: "Move to Trash" });
    await expect(go).toBeDisabled();
    await dialog.getByRole("textbox").fill("delete");
    await go.click();
    await expect.poll(() => requests.map((u) => u.pathname)).toEqual(["/delete-mac-graph"]);
    const request = requests[0] as URL;
    expect(request.searchParams.get("graph")).toBe(`mac:${id}`);
    expect(request.searchParams.get("key")).toBe("window-key");
    await reply(page, request, { ok: true, graphs: [graphs[0]] });
    await expect(menu.getByRole("status")).toHaveText("“Garden Shed” is in the Trash.");
    await expect(
      menu.getByRole("list", { name: "On this Mac" }).locator(".graph-switcher-label"),
    ).toHaveText(["This Mac"]);
  });

  test("B-786: a server graph's page offers no deletion of This Mac's graphs", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const id = `srvdel-${Date.now().toString(36)}`;
    const token = await createGraph(base, id, "Remote Graph");
    // The shell's own server is elsewhere (6100): to this page, this server is a remote one.
    await injectShell(
      page,
      6100,
      [
        mac(6100, "default", "This Mac"),
        mac(6100, "garden", "Garden"),
        server("s1", "Remote Graph", `${base}/g/${id}`),
      ],
      token,
      { deleteMac: true },
    );
    await asRemoteServer(page);
    await page.goto(`/g/${id}/journals`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    await openGraphMenu(page);
    const menu = page.getByRole("dialog", { name: "Graphs" });
    await expect(menu.getByRole("button", { name: /^Garden/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: /^Delete / })).toHaveCount(0);
  });

  test("B-787: Show graphs on this server (root token) asks the shell, and picking one asks for its device token", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    await injectShell(page, port, [mac(port, "default", "This Mac")], null, {
      listServerGraphs: true,
    });
    const requests = await catchShellRequests(page);
    const pageAskedGraphs: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/graphs") pageAskedGraphs.push(r.url());
    });
    const elsewhere = "https://notes.example.com";
    await page.goto("/g/default/journals");
    await openGraphMenu(page);
    await page.getByRole("button", { name: "Add a graph" }).click();
    const connect = page.getByRole("region", { name: "Connect to a server" });
    await connect.getByLabel("Server address").fill(elsewhere);
    const root = `nkroot_${"ef".repeat(24)}`;
    await connect.getByLabel("Device token or pairing link").fill(root);
    await connect.getByRole("button", { name: "Show graphs on this server (root token)" }).click();
    await expect.poll(() => requests.map((u) => u.pathname)).toEqual(["/list-server-graphs"]);
    const request = requests[0] as URL;
    expect(request.searchParams.get("address")).toBe(elsewhere);
    expect(request.searchParams.get("token")).toBe(root);
    await reply(page, request, {
      ok: true,
      serverGraphs: [
        { id: "default", label: "Home", address: `${elsewhere}/g/default` },
        { id: "work", label: "Work", address: `${elsewhere}/g/work` },
      ],
    });
    const list = connect.getByRole("list", { name: "Graphs on this server" });
    await expect(list.locator(".graph-switcher-label")).toHaveText(["Home", "Work"]);
    await list.getByRole("button", { name: /^Work/ }).click();
    await expect(connect.getByLabel("Server address")).toHaveValue(`${elsewhere}/g/work`);
    await expect(connect.getByLabel("Device token or pairing link")).toHaveValue("");
    await expect(connect.getByRole("status")).toContainText("nooklet token create --graph work");
    // The page never made the listing itself (cross-origin, B-704), and kept no root token.
    expect(pageAskedGraphs).toEqual([]);
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain(root);
  });

  test("B-783: the mismatch screen offers only Re-sync from the server and Open another graph", async ({
    page,
    baseURL,
  }) => {
    const base = baseURL as string;
    const port = Number(new URL(base).port);
    const id = `mm-${Date.now().toString(36)}`;
    await createGraph(base, id, "Mismatch Graph");
    await injectShell(page, port, [
      mac(port, "default", "This Mac"),
      mac(port, id, "Mismatch Graph"),
    ]);
    await page.goto(`/g/${id}/journals`);
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
    // The entry remembers another graph than the server now serves.
    await page.evaluate(() => {
      const graphs = JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as {
        id: string;
        graphInstanceId?: string;
      }[];
      const active = graphs.find((g) => g.id === localStorage.getItem("nooklet.activeGraphId"));
      if (!active) throw new Error("no active entry");
      active.graphInstanceId = "an-earlier-graph-instance";
      localStorage.setItem("nooklet.graphs", JSON.stringify(graphs));
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "The server has a different graph now" }),
    ).toBeVisible();
    await expect(page.getByText(/device-only/)).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Other graphs" })).toContainText("This Mac");
    await page.getByRole("button", { name: "Re-sync from the server" }).click();
    await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
      timeout: 20_000,
    });
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

  await openGraphMenu(page);
  await page.getByRole("button", { name: "Add a graph" }).click();
  await page.getByRole("button", { name: /Just this device/ }).click();
  await expect(page.locator(".app-topbar")).toBeVisible();

  await openGraphMenu(page);
  // B-780: the phone uses the desktop app's words.
  await expect(page.getByRole("list", { name: "On this phone" })).toBeVisible();
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
