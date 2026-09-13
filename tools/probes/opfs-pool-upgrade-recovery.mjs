/**
 * Probe (2026-09-13, verification of m10/tests-desktop, B-323): a browser profile the OLD client
 * already left broken — does the NEW client bring it back?
 *
 * B-323's fix tops the OPFS pool up on every start, and its entry said "a browser already in that
 * state recovers on its next start" by reading only. That browser is not the state
 * `e2e/tests/opfs-pool.spec.ts` builds (one EMPTY file): the old client's failed start has since
 * given the one slot to the database (a 4096-byte header naming `/nooklet.sqlite3`). The e2e suite
 * cannot switch client builds inside one origin, so this does it by hand: one persistent Chromium
 * profile, one data dir, one port (OPFS is per origin), a server started twice.
 *
 *   1. Build the client with the fix commented out and copy `apps/web/dist` somewhere (OLD_WEB);
 *      restore the line. A built sidecar (`node apps/desktop/build-sidecar.mjs`) supplies the server
 *      and the current client (`apps/desktop/sidecar/web`).
 *   2. cp tools/probes/opfs-pool-upgrade-recovery.mjs e2e/zz.mjs && cd e2e &&
 *      node zz.mjs <scratch-dir> <repo>/apps/desktop/sidecar <OLD_WEB> <repo>/apps/desktop/sidecar/web
 *      (from `e2e/` so `@playwright/test` resolves; delete the copy after.)
 *
 * Result 2026-09-13: old client `rendered:false`, pool `[4096]`, console `SAH pool is full. Cannot
 * create file /nooklet.sqlite3-journal` / `SQLITE_CANTOPEN … CREATE TABLE page`; new client on the
 * same profile `rendered:true`, indicator `synced`, an edit survives a reload and reaches the server,
 * pool six files with the database at 217 KiB. Exit 0. `CLEAN=1` skips planting the one-file pool.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [S, sidecar, oldWeb, newWeb] = process.argv.slice(2);
const port = 6408;
const base = `http://127.0.0.1:${port}`;
const data = join(S, "upgrade-data");
const profile = join(S, "upgrade-profile");
rmSync(data, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(data, { recursive: true });

async function serve(web) {
  const env = {
    ...process.env,
    NOOKLET_DATA: data,
    NODE_ENV: "production",
    NOOKLET_SQLITE_VEC_PATH: join(sidecar, "vec0.dylib"),
    ESBUILD_BINARY_PATH: join(sidecar, "esbuild"),
  };
  const p = spawn(
    join(sidecar, "node"),
    [join(sidecar, "server.mjs"), "serve", "--data", data, "--port", String(port), "--web", web],
    { env, cwd: "/" },
  );
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { p, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not healthy: ${log}`);
}
async function stop(s) {
  s.p.kill("SIGTERM");
  await new Promise((r) => s.p.on("exit", r));
}
const poolState = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vfs = await root.getDirectoryHandle(".nooklet-opfs-sahpool");
    const opaque = await vfs.getDirectoryHandle(".opaque");
    const out = [];
    for await (const [_name, h] of opaque.entries()) out.push((await h.getFile()).size);
    return out;
  });

// Phase 1: old client, pool of one empty file, open the app.
let s = await serve(oldWeb);
let { token } = await (await fetch(`${base}/api/session`)).json();
const call = (op, body) =>
  fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
await call("page.create", { name: "Upgrade Probe" });
await call("page.append", { page: "Upgrade Probe", markdown: "- survived the upgrade" });
let ctx = await chromium.launchPersistentContext(profile, { serviceWorkers: "block" });
let page = ctx.pages()[0] ?? (await ctx.newPage());
const logs1 = [];
page.on("console", (m) => {
  if (/SAH|CANTOPEN/.test(m.text())) logs1.push(m.text().slice(0, 100));
});
await page.goto(`${base}/icon.svg`);
if (!process.env.CLEAN)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vfs = await root.getDirectoryHandle(".nooklet-opfs-sahpool", { create: true });
    const opaque = await vfs.getDirectoryHandle(".opaque", { create: true });
    await opaque.getFileHandle("interruptedslot", { create: true });
  });
await page.goto(`${base}/page/Upgrade%20Probe`);
const oldRendered = await page
  .locator(".vr-outliner")
  .first()
  .getByText("survived the upgrade")
  .waitFor({ timeout: 10_000 })
  .then(
    () => true,
    () => false,
  );
await page.goto(`${base}/icon.svg`);
await page.waitForTimeout(500);
const pool1 = await poolState(page);
console.log(
  JSON.stringify({
    phase: "old client",
    rendered: oldRendered,
    poolFileSizes: pool1,
    console: logs1.slice(0, 3),
  }),
);
await ctx.close();
await stop(s);

// Phase 2: new client, same origin, same profile.
s = await serve(newWeb);
({ token } = await (await fetch(`${base}/api/session`)).json());
ctx = await chromium.launchPersistentContext(profile, { serviceWorkers: "block" });
page = ctx.pages()[0] ?? (await ctx.newPage());
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const pushes = [];
page.on("response", async (r) => {
  if (r.url().includes("/sync/push"))
    pushes.push(`${r.status()} ${(await r.text().catch(() => "")).slice(0, 200)}`);
});
page.on("requestfailed", (r) => {
  if (r.url().includes("/sync/")) pushes.push(`FAILED ${r.url()} ${r.failure()?.errorText}`);
});
await page.goto(`${base}/page/Upgrade%20Probe`);
const outliner = page.locator(".vr-outliner").first();
const newRendered = await outliner
  .getByText("survived the upgrade")
  .waitFor({ timeout: 15_000 })
  .then(
    () => true,
    () => false,
  );
let indicator = "";
let persisted = false;
if (newRendered) {
  await page.waitForTimeout(500);
  indicator = (await page.locator(".app-sync-indicator").textContent()) ?? "";
  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and wrote", { delay: 20 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  await page.reload();
  persisted = await page
    .locator(".vr-outliner")
    .first()
    .getByText("survived the upgrade and wrote")
    .waitFor({ timeout: 15_000 })
    .then(
      () => true,
      () => false,
    );
}
let server = "";
for (let i = 0; i < 40 && !server.includes("and wrote"); i++) {
  await page.waitForTimeout(250);
  server = await (await call("page.read", { page: "Upgrade Probe" })).text();
}
await page.goto(`${base}/icon.svg`);
await page.waitForTimeout(500);
const pool2 = await poolState(page);
console.log(
  JSON.stringify({
    phase: "new client",
    rendered: newRendered,
    indicator,
    persisted,
    serverHasEdit: server.includes("and wrote"),
    server: server.slice(0, 300),
    pushes,
    poolFileSizes: pool2,
    pageErrors: errs.slice(0, 3),
  }),
);
await ctx.close();
await stop(s);
process.exit(
  oldRendered === false && newRendered && persisted && server.includes("and wrote") ? 0 : 1,
);
