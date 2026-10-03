/**
 * Flow 3: "Just this device" first, a server graph added later, on an emulated Capacitor shell
 * (Chromium, so OPFS persists across reloads; `window.Capacitor.isNativePlatform()` stubbed true so
 * `platform.name === "capacitor"` and the Capacitor-only UI paths run). The app is served by
 * host-proxy.mjs's static mode at :6313, which also proxies /g/* to the server — so the "server
 * address" is same-origin and CORS is deliberately out of the picture here.
 */
import { readFileSync } from "node:fs";
import { chromium, expect, type Page, test } from "@playwright/test";

const APP = process.env.SWEEP_CAP_APP ?? "http://127.0.0.1:6313";
const T = JSON.parse(readFileSync(process.env.SWEEP_TOKENS ?? "tokens.json", "utf8"));
const obs = (...a: unknown[]) => console.log("OBS:", ...a);
// Which server graph "Add a graph" joins. Run 1 used "default" when it had no journal for today
// yet; a fresh graph (POST /graphs) reproduces that condition.
const LG = process.env.SWEEP_LT_GRAPH ?? "default";
const LTOK = process.env.SWEEP_LT_TOKEN ?? T.default.mac;
const NOTE = `LOCAL ONLY NOTE ${Date.now() % 100000}`;
const onServer = async (m: string) => {
  const r = await fetch(`http://127.0.0.1:6311/g/${LG}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LTOK}` },
    body: JSON.stringify({ query: m.split(" ").pop() }),
  });
  return JSON.stringify(((await r.json()) as { hits: unknown[] }).hits).includes(m);
};
const label = async (p: Page) =>
  (await p.locator(".app-sync-indicator").getAttribute("aria-label").catch(() => null)) ?? "(none)";
const graphs = (p: Page) => p.evaluate(() => [localStorage.getItem("nooklet.graphs"), localStorage.getItem("nooklet.activeGraphId")]);
const opfs = (p: Page) =>
  p.evaluate(async () => {
    const out: string[] = [];
    const walk = async (d: FileSystemDirectoryHandle, pre: string) => {
      // @ts-expect-error entries() exists in Chromium
      for await (const [n, h] of d.entries()) {
        out.push(pre + n);
        if (h.kind === "directory" && out.length < 60) await walk(h, `${pre + n}/`);
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return out.filter((n) => !/\/\.opaque|^\.opaque/.test(n)).slice(0, 40);
  });

test("local-only first, then add a server graph (Capacitor emulated)", async () => {
  test.setTimeout(180_000);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: false });
  await ctx.addInitScript(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: () => false,
      Plugins: {},
    };
  });
  const p = await ctx.newPage();
  const errs = new Set<string>();
  p.on("pageerror", (e) => errs.add(String(e).slice(0, 160)));

  await p.goto(`${APP}/`);
  await p.getByRole("button", { name: /Just this device/s }).click();
  const draft = p.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible({ timeout: 20_000 });
  await draft.fill(NOTE);
  await p.keyboard.press("Enter");
  await p.keyboard.press("Escape");
  await expect(p.locator(".journal-day-today")).toContainText(NOTE);
  obs("local-only: label =", await label(p), "graph list =", await graphs(p));

  // Second launch — after a settle delay (SWEEP_LT_SETTLE_MS), so "lost on relaunch" cannot be
  // blamed on reloading inside the write's own in-flight window.
  await p.waitForTimeout(Number(process.env.SWEEP_LT_SETTLE_MS ?? 0));
  obs("before relaunch: unapplied batches =", await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied"))));
  await p.reload();
  const choice = await p.getByRole("button", { name: /Just this device/s }).isVisible({ timeout: 8000 }).catch(() => false);
  obs("second launch shows the set-up choice again:", choice);
  if (choice) await p.getByRole("button", { name: /Just this device/s }).click();
  // SWEEP_LT_FAST=1: run 1's timing — only ~3 s on the relaunched page before "Add a graph", i.e.
  // before B-247's second replay pass (+5 s) has run.
  const FAST = process.env.SWEEP_LT_FAST === "1";
  if (FAST) await p.waitForTimeout(3000);
  obs("relaunch: unapplied batches now =", await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied"))));
  const kept = FAST
    ? (await p.locator(".journal-day-today").innerText().catch(() => "")).includes(NOTE)
    : await expect(p.locator(".journal-day-today"))
        .toContainText(NOTE, { timeout: 15_000 })
        .then(() => true, () => false);
  obs(
    "second launch still has LOCAL ONLY NOTE:",
    kept,
    "| today text:",
    (await p.locator(".journal-day-today").innerText().catch(() => "")).slice(0, 120).replace(/\n+/g, " / "),
  );
  // Wait for the worker to finish whatever the relaunch started (B-247 replay runs again at +5 s).
  if (!FAST) await p.waitForTimeout(6000);

  // What the switcher offers in local-only mode.
  await p.getByRole("button", { name: "Switch graph" }).click();
  obs("switcher (local mode) text:", (await p.locator(".graph-switcher-popover, .graph-switcher").first().innerText().catch(() => "?")).replace(/\n+/g, " | "));
  await p.getByText("Add a graph").click();
  obs("add-choice text:", (await p.locator(".graph-switcher-popover, .graph-switcher").first().innerText().catch(() => "?")).replace(/\n+/g, " | "));
  const syncBtn = p.getByRole("button", { name: /Sync with a server|server/i }).first();
  await syncBtn.click();
  await p.getByLabel("Server address").fill(`${APP}/g/${LG}`);
  await p.getByLabel("Device token").fill(LTOK);
  await p.getByRole("button", { name: "Connect" }).click();
  await p.waitForTimeout(6000);
  obs("after adding server: url =", p.url(), "label =", await label(p), "list =", await graphs(p));
  obs("after adding server: local note ON THE SERVER graph", LG, "=", await onServer(NOTE));
  obs("after adding server: today shows LOCAL ONLY NOTE:", (await p.locator(".journal-day-today").innerText().catch(() => "")).includes(NOTE));

  await p.getByRole("button", { name: "Switch graph" }).click();
  const sw = (await p.locator(".graph-switcher-popover, .graph-switcher").first().innerText().catch(() => "?")).replace(/\n+/g, " | ");
  obs("switcher after adding server:", sw);
  await p.keyboard.press("Escape");
  obs("OPFS files:", await opfs(p));

  // Can the local-only graph be reached again? Try a fresh launch -> "Just this device".
  await p.reload();
  await p.waitForTimeout(4000);
  obs("relaunch after adding server: connect screen =", await p.locator(".connect").isVisible(), "label =", await label(p));

  // The other entry path: a fresh device that writes locally, then picks "Sync with a server" on
  // the next launch's ConnectView (the screen's own copy says "You'll see this screen again if you
  // want to add a server later").
  const ctx2 = await b.newContext({ viewport: { width: 393, height: 852 } });
  await ctx2.addInitScript(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", isPluginAvailable: () => false, Plugins: {} };
  });
  const q = await ctx2.newPage();
  await q.goto(`${APP}/`);
  await q.getByRole("button", { name: /Just this device/s }).click();
  const d2 = q.locator(".journal-day-today .vr-draft-input").first();
  await expect(d2).toBeVisible({ timeout: 20_000 });
  await d2.fill("LOCAL NOTE PATH B");
  await q.keyboard.press("Enter");
  await q.keyboard.press("Escape");
  await expect(q.locator(".journal-day-today")).toContainText("LOCAL NOTE PATH B");
  await q.reload();
  await q.getByRole("button", { name: /Sync with a server/s }).click();
  await q.getByLabel("Server address").fill(`${APP}/g/default`);
  await q.getByLabel("Device token").fill(T.default.mac);
  await q.getByRole("button", { name: "Connect" }).click();
  await expect(q.locator(".connect")).toHaveCount(0, { timeout: 20_000 });
  await q.waitForTimeout(4000);
  obs("path B after connect: today shows LOCAL NOTE PATH B:", (await q.locator(".journal-day-today").innerText().catch(() => "")).includes("LOCAL NOTE PATH B"), "list =", await graphs(q));
  await q.getByRole("button", { name: "Switch graph" }).click();
  obs("path B switcher:", (await q.locator(".graph-switcher-popover, .graph-switcher").first().innerText().catch(() => "?")).replace(/\n+/g, " | "));
  obs("pageerrors:", JSON.stringify([...errs]));
  await b.close();
});
