/**
 * Does a BUILT desktop sidecar load the built-in plugins? (B-180)
 *
 *   node apps/desktop/build-sidecar.mjs
 *   node tools/probes/sidecar-plugins.mjs [sidecar-dir] [port]
 *
 * Copies the sidecar into a fresh temp directory laid out like the app bundle
 * (`nooklet.app/Contents/Resources/sidecar`), makes the copy READ-ONLY (as when the app runs from
 * its disk image), and starts it the way `apps/desktop/src-tauri/src/main.rs#spawn_server` does —
 * from `/`, on a throwaway graph in the same temp directory, so nothing resolves through this
 * checkout and the owner's graph is never opened. Then asks it what a person or an agent would:
 * which plugins are running, does `page.wordcount` answer, is `page_wordcount` an MCP tool, and is
 * word-count's client half served.
 *
 * Built against `cf08d19`'s sidecar (no `plugins/` shipped) it printed `plugins: []` and
 * `page.wordcount -> 404`. Exits non-zero when any check fails.
 */

import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sidecarSrc = resolve(process.argv[2] ?? join(repoRoot, "apps", "desktop", "sidecar"));
const port = Number(process.argv[3] ?? 6405);
const base = `http://127.0.0.1:${port}`;

const root = mkdtempSync(join(tmpdir(), "nooklet-sidecar-probe-"));
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
// The sidecar must find its plugins on its own, not through a variable this shell happens to have.
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

const results = {};
let failed = false;
function check(name, ok, detail) {
  results[name] = { ok, detail };
  if (!ok) failed = true;
}

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
  const op = async (name, body) => {
    const res = await fetch(`${base}/api/v1/${name}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };

  const { plugins } = await (await fetch(`${base}/api/v1/plugins`, { headers: auth })).json();
  const ids = plugins.map((p) => p.id).sort();
  check("plugins listed", ids.join(",") === "daily-summary,mermaid,word-count", plugins);

  await op("page.create", { name: "Probe Count", markdown: "- one two three\n- four" });
  const count = await op("page.wordcount", { page: "Probe Count" });
  check("page.wordcount answers", count.status === 200 && count.json?.word_count === 4, count);

  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...auth, host: "localhost", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await mcp.text();
  const payload = text.includes("data:")
    ? JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          .slice(5),
      )
    : JSON.parse(text);
  const tools = payload.result?.tools?.map((t) => t.name) ?? [];
  check("page_wordcount MCP tool", tools.includes("page_wordcount"), `${tools.length} tools`);

  const clientUrl = plugins.find((p) => p.id === "word-count")?.client_url;
  const client = clientUrl ? await fetch(`${base}${clientUrl}`) : undefined;
  check("word-count client half served", client?.status === 200, clientUrl);
} catch (e) {
  check("probe ran", false, String(e));
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  chmodTree(resources, 0o755, 0o644, 0o755);
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ sidecar: sidecarSrc, results }, null, 2));
if (/\[plugins\]|plugin discovery error/.test(log)) console.log(`server log:\n${log}`);
process.exit(failed ? 1 : 0);
