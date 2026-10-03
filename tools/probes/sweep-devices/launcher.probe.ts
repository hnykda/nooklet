/**
 * Flow 4: the desktop launcher's picker (apps/desktop/launcher/index.html) — list / add / remove /
 * switch, and the unreachable-at-startup recheck — driven in Chromium with Tauri's `invoke`
 * stubbed and recording its ARGUMENTS (the e2e spec records only command names). Same serving
 * technique as e2e/tests/desktop-launcher.spec.ts. No GUI, no real Rust; the real click-through in
 * the .app is still owed by a human.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const launcherDir = fileURLToPath(new URL("../../../apps/desktop/launcher/", import.meta.url));
const ORIGIN = "http://localhost:6419";
const obs = (...a: unknown[]) => console.log("OBS:", ...a);
const up = new Set<string>(["6311"]);

async function open(page: Page, desktop: { graphs: Array<{ id: string; url: string }>; activeGraphId: string | null; forcePicker: boolean }) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: join(launcherDir, path === "/" ? "index.html" : path) });
  });
  // A real fetch from this fake routed origin to 127.0.0.1 fails in Playwright Chromium ("Failed
  // to fetch", even for a live server), so reachability is routed too: `up` decides who answers.
  await page.route(/127\.0\.0\.1:63\d\d\//, (route) => {
    const port = new URL(route.request().url()).port;
    return up.has(port)
      ? route.fulfill({ contentType: "text/html", body: "<title>server</title>server answered" })
      : route.abort("connectionrefused");
  });
  await page.addInitScript((d) => {
    const w = window as unknown as Record<string, unknown> & { __calls: unknown[] };
    w.__calls = [];
    w.__NOOKLET_DESKTOP__ = Object.freeze({ platform: "macos", port: 6100, ...d });
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        w.__calls.push([cmd, args ?? null]);
        if (cmd === "server_status") return { state: "starting" };
        if (cmd === "add_graph") return { id: "gnew", url: (args as { url: string }).url };
        return null;
      },
    };
  }, desktop);
  await page.goto(`${ORIGIN}/`);
  return () => page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls.filter((c) => (c as string[])[0] !== "server_status"));
}

test("picker: list, remove, add (validation, unreachable, good), switch", async ({ page }) => {
  const calls = await open(page, {
    graphs: [
      { id: "g1", url: "http://127.0.0.1:6311/g/default" },
      { id: "g2", url: "http://127.0.0.1:6311/g/work" },
    ],
    activeGraphId: "g1",
    forcePicker: true,
  });
  await expect(page.locator("#picker")).toBeVisible();
  obs("rows:", (await page.locator("#graph-list").innerText()).replace(/\n+/g, " | "));
  obs("remove buttons:", await page.locator(".row-remove").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label"))));
  await page.locator(".row-remove").first().click();
  obs("after remove: rows =", (await page.locator("#graph-list").innerText()).replace(/\n+/g, " | "), "calls =", JSON.stringify(await calls()));

  await page.getByRole("button", { name: /Add a server/ }).click();
  await page.locator("#picker-url").fill("nooklet.example.com");
  await page.getByRole("button", { name: "Connect" }).click();
  obs("no scheme ->", await page.locator("#picker-err").textContent());
  await page.locator("#picker-url").fill("http://127.0.0.1:6312/g/work");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("#picker-err")).not.toHaveText("Checking…", { timeout: 15_000 });
  obs("unreachable ->", await page.locator("#picker-err").textContent());
  await page.locator("#picker-url").fill("http://127.0.0.1:6311/g/work/");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForTimeout(4000);
  obs("good add -> picker-err =", await page.locator("#picker-err").textContent(), "saved visible =", await page.locator("#picker-saved").isVisible(), "page fetch:", await page.evaluate(() => fetch("http://127.0.0.1:6311/healthz", { mode: "no-cors" }).then(() => "ok", (e) => String(e))));
  await page.waitForTimeout(1500);
  obs("good add -> calls =", JSON.stringify(await calls()));
});

test("picker: choosing a different row sets it active and restarts; This Mac = null", async ({ page }) => {
  const calls = await open(page, { graphs: [{ id: "g1", url: "http://127.0.0.1:6311/g/default" }], activeGraphId: "g1", forcePicker: true });
  await page.getByRole("button", { name: /This Mac/ }).click();
  await page.waitForTimeout(1600);
  obs("pick This Mac -> calls =", JSON.stringify(await calls()));
});

test("active server unreachable at startup -> picker with error -> auto-reconnects when it comes back", async ({ page }) => {
  test.setTimeout(90_000);
  const calls = await open(page, { graphs: [{ id: "g1", url: "http://127.0.0.1:6313/g/default" }], activeGraphId: "g1", forcePicker: false });
  await page.waitForTimeout(8000);
  obs("unreachable at startup: picker visible =", await page.locator("#picker").isVisible(), "| problem/help visible =", await page.locator("#help").isVisible(), "| text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 300));
  up.add("6313");
  const t0 = Date.now();
  await page.waitForURL(/127\.0\.0\.1:6313/, { timeout: 30_000 }).catch(() => {});
  obs("after server came back: url =", page.url(), "after", Date.now() - t0, "ms; calls =", JSON.stringify(await calls()));
});
