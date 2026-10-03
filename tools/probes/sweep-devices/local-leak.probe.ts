/**
 * Narrowing local-then-server.probe.ts's finding: a note written in Capacitor "Just this device"
 * mode turned up ON THE SERVER, in an existing populated graph, after "Add a graph" from the
 * switcher. Checks the server after every step to find the step that pushes it.
 */
import { readFileSync } from "node:fs";
import { chromium, expect, type Page, test } from "@playwright/test";

const APP = process.env.SWEEP_CAP_APP ?? "http://127.0.0.1:6313";
const T = JSON.parse(readFileSync(process.env.SWEEP_TOKENS ?? "tokens.json", "utf8"));
const obs = (...a: unknown[]) => console.log("OBS:", ...a);
// "work" by default: a server graph with NO journal for today yet (as on the first run, where the
// leak showed). SWEEP_LEAK_GRAPH=default reproduces the later runs, where today already existed.
const G = process.env.SWEEP_LEAK_GRAPH ?? "work";
const onServer = async (marker: string) => {
  const r = await fetch(`http://127.0.0.1:6311/g/${G}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${T[G].mac}` },
    body: JSON.stringify({ query: marker }),
  });
  return ((await r.json()) as { hits: unknown[] }).hits.length > 0;
};
const state = (p: Page) =>
  p.evaluate(() => ({
    unapplied: Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied-ops")),
    graphs: localStorage.getItem("nooklet.graphs"),
    active: localStorage.getItem("nooklet.activeGraphId"),
    url: location.href,
  }));

test("where does the local-only note leak to the server", async () => {
  test.setTimeout(150_000);
  const marker = `LEAKPROBE${Date.now() % 1000000}`;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.addInitScript(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: () => false,
      Plugins: {},
    };
  });
  const p = await ctx.newPage();
  p.on("request", (r) => {
    if (/\/sync\/push|\/sync\/bootstrap|\/sync\/pull/.test(r.url()))
      console.log("REQ", r.method(), r.url());
  });
  await p.goto(`${APP}/`);
  await p.getByRole("button", { name: /Just this device/s }).click();
  const draft = p.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible({ timeout: 20_000 });
  await draft.fill(marker);
  await p.keyboard.press("Enter");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(2000);
  obs("1 after local write: on server =", await onServer(marker), JSON.stringify(await state(p)));

  // A second launch, as a phone user would have days later (and as local-then-server.probe.ts did).
  await p.reload();
  await p.getByRole("button", { name: /Just this device/s }).click();
  await p.waitForTimeout(2000);
  obs("1b after relaunch:", JSON.stringify(await state(p)));
  obs(
    "1b after relaunch: IndexedDB dbs =",
    JSON.stringify(await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))),
  );
  await p.getByRole("button", { name: "Switch graph" }).click();
  await p.getByText("Add a graph").click();
  await p.getByRole("button", { name: /Sync with a server/ }).click();
  await p.getByLabel("Server address").fill(`${APP}/g/${G}`);
  await p.getByLabel("Device token").fill(T[G].mac);
  await p.getByRole("button", { name: "Connect" }).click();
  await p.waitForURL(new RegExp(`/g/${G}/`), { timeout: 20_000 });
  obs("2 right after add-server navigation:", JSON.stringify(await state(p)));
  await p.waitForTimeout(6000);
  obs("3 6s later: on server =", await onServer(marker), JSON.stringify(await state(p)));
  obs(
    "  today shows marker =",
    (
      await p
        .locator(".journal-day-today")
        .innerText()
        .catch(() => "")
    ).includes(marker),
  );
  await b.close();
});
