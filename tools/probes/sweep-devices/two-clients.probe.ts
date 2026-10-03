/**
 * Flows 1, 2 and 6 of the device-readiness sweep: two NON-loopback clients ("mac" = Chromium,
 * "phone" = WebKit at an iPhone viewport) join a 2-graph server through the real ConnectView,
 * switch graphs, sync both ways, survive offline edits and a server restart.
 *
 * Every step logs `OBS:` lines; checks are soft so one break does not hide the rest.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  chromium,
  devices,
  expect,
  type Page,
  test,
  webkit,
} from "@playwright/test";

const BASE = process.env.SWEEP_BASE ?? "http://192.168.1.5:6311";
const DATA = process.env.SWEEP_DATA ?? "";
const HOST = process.env.SWEEP_SERVER_HOST ?? new URL(BASE).hostname;
const PORT = process.env.SWEEP_SERVER_PORT ?? new URL(BASE).port;
const T = JSON.parse(readFileSync(process.env.SWEEP_TOKENS ?? "tokens.json", "utf8"));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVE = join(HERE, "serve.sh");
const obs = (...a: unknown[]) => console.log("OBS:", ...a);

async function apiCall(graph: string, token: string, op: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/g/${graph}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function serverPageText(graph: string, token: string, name: string): Promise<string> {
  try {
    const r = (await apiCall(graph, token, "page.read", { page: name, format: "outline" })) as {
      markdown?: string;
      content?: string;
    };
    return JSON.stringify(r);
  } catch (e) {
    return String(e);
  }
}

async function syncLabel(page: Page): Promise<string> {
  return (
    (await page
      .locator(".app-sync-indicator")
      .getAttribute("aria-label")
      .catch(() => null)) ?? "(none)"
  );
}

async function joinViaConnectView(page: Page, url: string, token: string, who: string) {
  await page.goto(url);
  const connect = page.locator(".connect");
  await expect(connect).toBeVisible();
  obs(who, "connect screen shown at", page.url());
  await connect.getByRole("button", { name: /Sync with a server/s }).click();
  await connect.getByLabel("Device token").fill(token);
  await connect.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".connect")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".app-sync-indicator")).toBeVisible();
  obs(who, "joined; url =", page.url(), "sync =", await syncLabel(page));
}

/** Appends a block at the end of `name`'s outliner through the real editor. */
async function typeBlock(page: Page, text: string) {
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  await outliner.locator(".vr-block-view").last().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press("Escape");
  await expect(outliner).toContainText(text);
}

async function waitSeen(page: Page, text: string, who: string, ms = 20_000): Promise<boolean> {
  const t0 = Date.now();
  try {
    await expect(page.locator(".vr-outliner").first()).toContainText(text, { timeout: ms });
    obs(who, `saw "${text}" after ${Date.now() - t0} ms (no reload)`);
    return true;
  } catch {
    obs(who, `did NOT see "${text}" within ${ms} ms; sync =`, await syncLabel(page));
    return false;
  }
}

function killServer() {
  const pid = readFileSync(join(DATA, "server.pid"), "utf8").trim();
  // serve.sh records pnpm's pid; kill the whole process group of listeners on the port instead.
  try {
    execFileSync("bash", [
      "-c",
      `lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill; kill ${pid} 2>/dev/null; true`,
    ]);
  } catch {}
}
function startServer() {
  execFileSync(SERVE, [DATA, PORT, HOST, process.env.SWEEP_ALLOW_HOST ?? ""], { stdio: "inherit" });
}

let chrome: Browser;
let wk: Browser;
let macCtx: BrowserContext;
let phoneCtx: BrowserContext;
let mac: Page;
let phone: Page;
const PAGE = "Sweep Shared";
const PAGE_PATH = `/page/${encodeURIComponent(PAGE)}`;

test.describe
  .serial("two clients", () => {
    test.beforeAll(async () => {
      chrome = await chromium.launch();
      wk = await webkit.launch();
      macCtx = await chrome.newContext();
      phoneCtx = await wk.newContext({ ...devices["iPhone 15"] });
      mac = await macCtx.newPage();
      phone = await phoneCtx.newPage();
      for (const [n, p] of [
        ["mac", mac],
        ["phone", phone],
      ] as const) {
        p.on("console", (m) => {
          if (m.type() === "error") console.log(`[${n} console.error]`, m.text().slice(0, 300));
        });
        p.on("pageerror", (e) => console.log(`[${n} pageerror]`, String(e).slice(0, 300)));
      }
      await apiCall("default", T.default.mac, "page.create", {
        name: PAGE,
        if_exists: "return",
        markdown: "- seed from server",
      });
      await apiCall("work", T.work.mac, "page.create", {
        name: "Only In Work",
        if_exists: "return",
        markdown: "- work-only content",
      });
    });
    test.afterAll(async () => {
      await chrome?.close();
      await wk?.close();
    });

    test("1a. wrong token is rejected readably", async () => {
      await mac.goto(`${BASE}/`);
      obs("bare origin redirected to", mac.url());
      const connect = mac.locator(".connect");
      await expect(connect).toBeVisible();
      await connect.getByRole("button", { name: /Sync with a server/s }).click();
      await connect.getByLabel("Device token").fill("nk_wrong");
      await connect.getByRole("button", { name: "Connect" }).click();
      const err = await connect.locator(".connect-error").textContent({ timeout: 10_000 });
      obs("wrong token message:", err);
      expect.soft(err).toContain("rejected");
      // A token for graph "work" used against graph "default".
      await connect.getByLabel("Device token").fill(T.work.mac);
      await connect.getByRole("button", { name: "Connect" }).click();
      await expect(connect.locator(".connect-error")).toBeVisible();
      obs("other-graph token message:", await connect.locator(".connect-error").textContent());
    });

    test("1b. both clients join graph default via ConnectView", async () => {
      await joinViaConnectView(mac, `${BASE}/`, T.default.mac, "mac");
      expect.soft(mac.url()).toContain("/g/default/");
      await joinViaConnectView(phone, `${BASE}/`, T.default.phone, "phone");
      expect.soft(phone.url()).toContain("/g/default/");
    });

    test("1c. mac adds graph work through the switcher, switches back and forth (B-586)", async () => {
      await mac.getByRole("button", { name: "Switch graph" }).click();
      await mac.getByText("Add a graph").click();
      await mac.getByLabel("Server address").fill(`${BASE}/g/work`);
      await mac.getByLabel("Device token").fill(T.work.mac);
      await mac.getByRole("button", { name: "Connect" }).click();
      await expect(mac).toHaveURL(/\/g\/work\//, { timeout: 20_000 });
      obs("mac after add-graph url =", mac.url());
      await mac.goto(`${BASE}/g/work/page/${encodeURIComponent("Only In Work")}`);
      const sawWork = await waitSeen(mac, "work-only content", "mac(work)");
      expect.soft(sawWork).toBe(true);
      // Links rendered on the work graph carry the work prefix.
      const hrefs = await mac
        .locator("a[href^='/g/']")
        .evaluateAll((as) => as.slice(0, 5).map((a) => a.getAttribute("href")));
      obs("mac(work) sample hrefs:", hrefs);
      await mac.getByRole("button", { name: "Switch graph" }).click();
      const rows = await mac
        .locator(".graph-switcher-popover, [role=dialog], .graph-switcher")
        .first()
        .innerText()
        .catch(() => "?");
      obs("switcher list text:", rows.replace(/\n+/g, " | "));
      const list = await mac.evaluate(() => localStorage.getItem("nooklet.graphs"));
      obs("mac graph list:", list);
      // Click the row that is NOT active (the original "This graph" entry).
      await mac
        .getByRole("button", { name: /This graph/ })
        .first()
        .click();
      await expect(mac).toHaveURL(/\/g\/default\//, { timeout: 20_000 });
      obs("mac after switching back url =", mac.url());
      await mac.goto(`${BASE}/g/default${PAGE_PATH}`);
      expect.soft(await waitSeen(mac, "seed from server", "mac(default)")).toBe(true);
      const leaked = await mac.locator(".vr-outliner").first().innerText();
      expect.soft(leaked).not.toContain("work-only");
    });

    test("1d. adding a server WITHOUT /g/<slug> (what a user would type)", async () => {
      // Do it in a throwaway context so the main mac context is undisturbed.
      const ctx = await chrome.newContext();
      const p = await ctx.newPage();
      await joinViaConnectView(p, `${BASE}/`, T.default.mac, "mac2");
      await p.getByRole("button", { name: "Switch graph" }).click();
      await p.getByText("Add a graph").click();
      await p.getByLabel("Server address").fill(BASE);
      await p.getByLabel("Device token").fill(T.work.mac);
      await p.getByRole("button", { name: "Connect" }).click();
      await p.waitForTimeout(3000);
      const err = await p.locator(".graph-switcher-error, [role=alert]").allTextContents();
      obs("bare-address + work token -> url", p.url(), "errors:", err);
      await p
        .getByLabel("Device token")
        .fill(T.default.mac)
        .catch(() => {});
      await p
        .getByRole("button", { name: "Connect" })
        .click()
        .catch(() => {});
      await p.waitForTimeout(4000);
      obs(
        "bare-address + default token -> url",
        p.url(),
        "list:",
        await p.evaluate(() => localStorage.getItem("nooklet.graphs")),
        "sync:",
        await syncLabel(p),
      );
      await ctx.close();
    });

    test("2a. live sync both ways on graph default", async () => {
      await mac.goto(`${BASE}/g/default${PAGE_PATH}`);
      await phone.goto(`${BASE}/g/default${PAGE_PATH}`);
      await waitSeen(phone, "seed from server", "phone");
      obs("phone storage tier sync label:", await syncLabel(phone), "| mac:", await syncLabel(mac));
      await typeBlock(mac, "from mac live 1");
      expect.soft(await waitSeen(phone, "from mac live 1", "phone")).toBe(true);
      await typeBlock(phone, "from phone live 1");
      expect.soft(await waitSeen(mac, "from phone live 1", "mac")).toBe(true);
    });

    test("2b. offline edits on mac, concurrent edit on phone, reconnect, converge", async () => {
      await macCtx.setOffline(true);
      await mac.waitForTimeout(3000);
      obs("mac offline sync label:", await syncLabel(mac));
      await typeBlock(mac, "mac offline edit A");
      await typeBlock(mac, "mac offline edit B");
      await typeBlock(phone, "phone while mac offline");
      await mac.waitForTimeout(2000);
      obs("mac while offline, label:", await syncLabel(mac));
      obs(
        "server has mac offline A?",
        (await serverPageText("default", T.default.mac, PAGE)).includes("mac offline edit A"),
      );
      await macCtx.setOffline(false);
      const t0 = Date.now();
      const a = await waitSeen(phone, "mac offline edit B", "phone", 45_000);
      const b = await waitSeen(mac, "phone while mac offline", "mac", 45_000);
      obs(
        "convergence after reconnect took",
        Date.now() - t0,
        "ms; label mac:",
        await syncLabel(mac),
      );
      expect.soft(a && b).toBe(true);
    });

    test("2c. server restart mid-session; clients recover", async () => {
      killServer();
      await mac.waitForTimeout(4000);
      obs(
        "server down: mac label:",
        await syncLabel(mac),
        "| phone label:",
        await syncLabel(phone),
      );
      await typeBlock(mac, "mac during outage");
      await typeBlock(phone, "phone during outage");
      obs(
        "during outage after edits: mac:",
        await syncLabel(mac),
        "| phone:",
        await syncLabel(phone),
      );
      startServer();
      const t0 = Date.now();
      const a = await waitSeen(phone, "mac during outage", "phone", 60_000);
      const b = await waitSeen(mac, "phone during outage", "mac", 60_000);
      obs(
        "recovery after restart took",
        Date.now() - t0,
        "ms; mac:",
        await syncLabel(mac),
        "phone:",
        await syncLabel(phone),
      );
      expect.soft(a && b).toBe(true);
      // After recovery, a fresh live edit still flows without reload.
      await typeBlock(mac, "mac after restart live");
      expect.soft(await waitSeen(phone, "mac after restart live", "phone")).toBe(true);
      const server = await serverPageText("default", T.default.mac, PAGE);
      for (const s of [
        "from mac live 1",
        "from phone live 1",
        "mac offline edit A",
        "mac offline edit B",
        "phone while mac offline",
        "mac during outage",
        "phone during outage",
        "mac after restart live",
      ])
        obs(`server has "${s}":`, server.includes(s));
    });

    test("6a. revoked token mid-session", async () => {
      // Revoke the phone's default token via CLI, then make an edit on the phone.
      const out = execFileSync(
        "bash",
        [
          "-c",
          `cd ${join(HERE, "../../../packages/server")} && NOOKLET_DATA=${DATA} pnpm exec tsx src/cli.ts token list --data ${DATA} --graph default`,
        ],
        { encoding: "utf8" },
      );
      obs("token list:\n" + out);
      const id = out
        .split("\n")
        .find((l) => /\bphone\b/.test(l))
        ?.trim()
        .split(/\s+/)[0];
      obs("revoking phone token id", id);
      execFileSync("bash", [
        "-c",
        `cd ${join(HERE, "../../../packages/server")} && NOOKLET_DATA=${DATA} pnpm exec tsx src/cli.ts token revoke ${id} --data ${DATA} --graph default`,
      ]);
      await typeBlock(phone, "phone after revoke");
      await phone.waitForTimeout(8000);
      obs("phone after revoke, label:", await syncLabel(phone));
      obs(
        "server has phone-after-revoke:",
        (await serverPageText("default", T.default.mac, PAGE)).includes("phone after revoke"),
      );
      await phone.reload();
      await phone.waitForTimeout(5000);
      obs(
        "phone after reload with revoked token: connect screen?",
        await phone.locator(".connect").isVisible(),
        "label:",
        await syncLabel(phone),
        "body:",
        (await phone.locator("body").innerText()).slice(0, 200).replace(/\n+/g, " | "),
      );
    });
  });
