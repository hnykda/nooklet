/**
 * Flow 6 edges on a Chromium (OPFS) client, non-loopback via host-proxy.mjs:
 *  - what the sync indicator says while the server is down and nobody is typing;
 *  - a cold reload while the server is unreachable (service-worker shell + local replica);
 *  - a revoked token on a client that HAS a local replica.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page, test } from "@playwright/test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BASE = process.env.SWEEP_BASE ?? "http://127.0.0.1:6312";
const DATA = process.env.SWEEP_DATA ?? "";
const T = JSON.parse(readFileSync(process.env.SWEEP_TOKENS ?? "tokens.json", "utf8"));
const obs = (...a: unknown[]) => console.log("OBS:", ...a);
const label = async (p: Page) =>
  (await p.locator(".app-sync-indicator").getAttribute("aria-label").catch(() => null)) ?? "(none)";
const cli = (args: string) =>
  execFileSync(
    "bash",
    ["-c", `cd ${join(HERE, "../../../packages/server")} && NOOKLET_DATA=${DATA} pnpm exec tsx src/cli.ts ${args} --data ${DATA}`],
    { encoding: "utf8" },
  );
const kill = () => execFileSync("bash", ["-c", "lsof -ti tcp:6311 -sTCP:LISTEN | xargs kill; sleep 1; true"]);
const start = () =>
  execFileSync(join(HERE, "serve.sh"), [DATA, "6311", "127.0.0.1", "nooklet.sweep.test"], { stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 });

test("edges", async () => {
  test.setTimeout(240_000);
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  const tok = cli("token create --label edge --scope write --sync --graph default").match(/nk_[0-9a-f]+/)?.[0];
  await p.goto(`${BASE}/`);
  await p.getByRole("button", { name: /Sync with a server/s }).click();
  await p.getByLabel("Device token").fill(tok as string);
  await p.getByRole("button", { name: "Connect" }).click();
  await expect(p.locator(".app-sync-indicator")).toHaveAttribute("aria-label", "Synced", { timeout: 20_000 });
  await p.goto(`${BASE}/g/default/page/Sweep%20Shared`);
  await expect(p.locator(".vr-outliner").first()).toContainText("seed from server");
  const sw = await p.evaluate(async () => {
    const ready = navigator.serviceWorker?.ready;
    const r = await Promise.race([ready, new Promise((res) => setTimeout(() => res(undefined), 20_000))]);
    return Boolean((r as ServiceWorkerRegistration | undefined)?.active);
  });
  obs("service worker active:", sw);

  // 0. Same question with NO proxy in between (direct loopback, token injected), to rule out
  // host-proxy.mjs as the reason the indicator stays green.
  const direct = await ctx.newPage();
  await direct.goto("http://127.0.0.1:6311/g/default/page/Sweep%20Shared");
  await expect(direct.locator(".app-sync-indicator")).toHaveAttribute("aria-label", "Synced", { timeout: 20_000 });

  // 1. Indicator while the server is down and nobody types.
  kill();
  for (const s of [1, 3, 5, 10, 20, 30]) {
    await p.waitForTimeout(s === 1 ? 1000 : s === 3 ? 2000 : s === 5 ? 2000 : s === 10 ? 5000 : 10_000);
    obs(`server down ${s}s, no edits: label via proxy =`, await label(p), "| direct =", await label(direct));
  }

  await direct.close();
  // 2. Cold reload with the server unreachable.
  const t0 = Date.now();
  await p.reload().catch((e) => obs("reload threw:", String(e).slice(0, 120)));
  await p.waitForTimeout(12_000);
  obs(
    `cold reload while down (${Date.now() - t0} ms): connect screen =`,
    await p.locator(".connect").isVisible(),
    "label =",
    await label(p),
    "outliner has seed =",
    (await p.locator(".vr-outliner").first().innerText().catch(() => "")).includes("seed from server"),
    "body:",
    (await p.locator("body").innerText().catch(() => "")).slice(0, 160).replace(/\n+/g, " | "),
  );
  start();
  await p.waitForTimeout(8000);
  obs("after server back (no reload): label =", await label(p));

  // 3. Revoked token, client with a local replica.
  const list = cli("token list --graph default");
  const id = list.split("\n").filter((l) => /\bactive\b/.test(l) && /\bedge$/.test(l.trim())).pop()?.trim().split(/\s+/)[0];
  cli(`token revoke ${id} --graph default`);
  obs("revoked edge token", id);
  await p.reload();
  await p.waitForTimeout(8000);
  obs(
    "after revoke + reload: connect screen =",
    await p.locator(".connect").isVisible(),
    "label =",
    await label(p),
    "body:",
    (await p.locator("body").innerText().catch(() => "")).slice(0, 200).replace(/\n+/g, " | "),
  );
  // An edit with the revoked token: does it reach the server, and what does the indicator say?
  const outliner = p.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").last().click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  const marker = `edit with revoked token ${Date.now() % 100000}`;
  await p.keyboard.type(marker, { delay: 10 });
  await p.keyboard.press("Escape");
  for (const s of [3, 10, 20]) {
    await p.waitForTimeout(s === 3 ? 3000 : s === 10 ? 7000 : 10_000);
    obs(`revoked, ${s}s after an edit: label =`, await label(p));
  }
  const res = await fetch("http://127.0.0.1:6311/g/default/api/v1/page.read", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${T.default.mac}` },
    body: JSON.stringify({ page: "Sweep Shared", format: "outline" }),
  });
  obs("server has the revoked-token edit:", (await res.text()).includes(marker));
  await p.screenshot({ path: "/tmp/nooklet-sweep-revoked-chromium.png" });
  await b.close();
});
