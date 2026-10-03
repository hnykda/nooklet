/**
 * Does a BUILT desktop sidecar still draw mermaid diagrams, now that it ships one mermaid (the web
 * build's) instead of two?
 *
 *   pnpm --filter @nooklet/desktop run sidecar
 *   node tools/probes/sidecar-mermaid.mjs [sidecar-dir] [port]
 *
 * Starts a READ-ONLY copy of the sidecar the way `tools/probes/sidecar-plugins.mjs` does (temp
 * dir laid out like the app bundle, throwaway graph, `cwd: /`), then drives headless Chromium —
 * not the desktop GUI — against it:
 *
 * 1. the app on a page with a ```` ```mermaid ```` fence draws an SVG (the client half compiled
 *    into the web build, ADR 023 — what the desktop app actually runs);
 * 2. the mermaid plugin's client half the SERVER serves (`client_url` from `GET /api/v1/plugins`),
 *    imported into that page and activated against a minimal context, also draws an SVG — loading
 *    mermaid from the web build's `/static/mermaid.core-*.js`, because `build-sidecar.mjs` no
 *    longer inlines a second ~12 MB copy into it.
 *
 * Also prints the sidecar's size and the served client half's size. Exits non-zero on a failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sidecarSrc = resolve(process.argv[2] ?? join(repoRoot, "apps", "desktop", "sidecar"));
const port = Number(process.argv[3] ?? 6407);
const base = `http://127.0.0.1:${port}`;

const du = spawnSync("du", ["-sk", sidecarSrc], { encoding: "utf8" }).stdout.split("\t")[0];
console.log(`sidecar on disk: ${du} KiB`);

const root = mkdtempSync(join(tmpdir(), "nooklet-sidecar-mermaid-"));
const resources = join(root, "nooklet.app", "Contents", "Resources");
const sidecar = join(resources, "sidecar");
const data = join(root, "data");
mkdirSync(resources, { recursive: true });
mkdirSync(data);
cpSync(sidecarSrc, sidecar, { recursive: true });

function chmodTree(path, dirMode, fileMode, exeMode) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) chmodTree(join(path, name), dirMode, fileMode, exeMode);
    chmodSync(path, dirMode);
  } else {
    chmodSync(path, st.mode & 0o111 ? exeMode : fileMode);
  }
}
chmodTree(resources, 0o555, 0o444, 0o555);

const env = { ...process.env, NOOKLET_DATA: data, NODE_ENV: "production" };
delete env.NOOKLET_BUNDLED_PLUGINS_DIR;
env.NOOKLET_SQLITE_VEC_PATH = join(
  sidecar,
  process.platform === "darwin" ? "vec0.dylib" : "vec0.so",
);
env.ESBUILD_BINARY_PATH = join(sidecar, "esbuild");

let log = "";
const server = spawn(
  join(sidecar, "node"),
  [
    join(sidecar, "server.mjs"),
    "serve",
    "--data",
    data,
    "--port",
    String(port),
    "--web",
    join(sidecar, "web"),
  ],
  { cwd: "/", env },
);
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

let failed = false;
function check(name, ok, detail) {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failed = true;
}

let browser;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`sidecar never became healthy:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await fetch(`${base}/api/v1/page.create`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Sidecar Mermaid",
      markdown: "- ```mermaid\n  graph LR\n    Zahrada --> Sklizen\n  ```",
    }),
  });
  check("page created", created.ok, created.status);

  const { plugins } = await (await fetch(`${base}/api/v1/plugins`, { headers: auth })).json();
  const clientUrl = plugins.find((p) => p.id === "mermaid")?.client_url;
  const clientRes = clientUrl ? await fetch(`${base}${clientUrl}`) : undefined;
  const clientText = clientRes ? await clientRes.text() : "";
  check("mermaid client half served", clientRes?.status === 200, clientUrl);
  console.log(`served mermaid client half: ${clientText.length} bytes`);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));

  // 1. The app itself.
  await page.goto(`${base}/page/Sidecar%20Mermaid`);
  const svg = page.locator('.vr-plugin-fence[data-lang="mermaid"] svg').first();
  await svg.waitFor({ state: "visible", timeout: 30_000 });
  check("app draws the diagram", (await svg.textContent())?.includes("Zahrada"));
  check(
    "app loaded mermaid from the web build",
    requests.some((p) => /^\/static\/mermaid\.core-/.test(p)),
  );

  // 2. The server-served client half, through the URL import of the web build's mermaid.
  const served = await page.evaluate(async (url) => {
    const mod = await import(url);
    let renderer;
    const noop = () => ({ dispose() {} });
    await mod.default.activate({
      host: { theme: "light" },
      log: { warn: (...a) => console.warn(...a), info() {}, error() {} },
      registerCodeBlockRenderer: (_lang, r) => {
        renderer = r;
        return noop();
      },
      registerSlashCommand: noop,
    });
    const el = document.createElement("div");
    document.body.append(el);
    await renderer.render("graph TD\n  Jaro --> Leto", el, {
      signal: new AbortController().signal,
    });
    return el.innerHTML.slice(0, 20000);
  }, clientUrl);
  check("served client half draws the diagram", served.includes("<svg") && served.includes("Jaro"));
  check(
    "served client half reused the web build's mermaid (no second copy fetched)",
    !requests.some((p) => p.startsWith("/plugins/") && p !== clientUrl),
  );
} catch (e) {
  check("probe ran", false, String(e));
} finally {
  await browser?.close();
  server.kill();
  chmodTree(resources, 0o755, 0o644, 0o755);
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
