/**
 * Can a BUILT desktop sidecar run a plugin the user put in `<data>/plugins`? (B-336)
 *
 *   node apps/desktop/build-sidecar.mjs
 *   node tools/probes/sidecar-user-plugin.mjs [sidecar-dir] [port]
 *
 * Copies the sidecar out of the repo (so nothing resolves through this checkout's `node_modules`),
 * writes the smallest plugin shaped like the documented ones — a server half importing
 * `@nooklet/plugin-api` and `zod` — into a throwaway graph's `plugins/`, starts the sidecar the way
 * `apps/desktop/src-tauri/src/main.rs#spawn_server` does, and calls the plugin's op.
 *
 * On `m9/cleanup` (after B-180) it printed `hello.say -> 404` and the server log said
 * `Could not resolve "@nooklet/plugin-api"` / `Could not resolve "zod"`: the loader aliases those to
 * the server's own installed copies, and a bundled server has none. Exits non-zero while that holds.
 * Same at `70c9bb9` (m10/tests-desktop). Fixed there by shipping those modules in the sidecar's
 * `host-modules/` (`packages/server/src/plugins/bundled.ts#packageHostModules`): exits 0.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sidecarSrc = resolve(process.argv[2] ?? join(repoRoot, "apps", "desktop", "sidecar"));
const port = Number(process.argv[3] ?? 6405);
const base = `http://127.0.0.1:${port}`;

const root = mkdtempSync(join(tmpdir(), "nooklet-sidecar-user-plugin-"));
const sidecar = join(root, "sidecar");
const data = join(root, "data");
const plugin = join(data, "plugins", "hello");
cpSync(sidecarSrc, sidecar, { recursive: true });
mkdirSync(join(plugin, "src"), { recursive: true });
writeFileSync(
  join(plugin, "package.json"),
  JSON.stringify({
    name: "nooklet-plugin-hello",
    version: "0.0.1",
    type: "module",
    nooklet: { id: "hello", name: "Hello", api: "1", server: "./src/server.ts", permissions: [] },
  }),
);
writeFileSync(
  join(plugin, "src", "server.ts"),
  // A complete `OpDef` (docs/spec/api-and-plugin-types.md §1.2). The first version of this probe
  // left out `summary`, `annotations` and `scopes`; once the imports resolved (B-336), that op took
  // the whole server down at startup — B-402.
  `import { defineOp, type ServerPluginModule } from "@nooklet/plugin-api";
import { z } from "zod";
const mod: ServerPluginModule = {
  activate(ctx) {
    ctx.ops.register(defineOp({
      name: "hello.say",
      summary: "Say hi",
      description: "Says hi.",
      input: z.object({}),
      output: z.object({ hi: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopes: ["read"],
      expose: { http: true },
      handler: async () => ({ hi: "there" }),
    }));
  },
};
export default mod;
`,
);

const env = { ...process.env, NOOKLET_DATA: data, NODE_ENV: "production" };
delete env.NOOKLET_BUNDLED_PLUGINS_DIR;
delete env.NOOKLET_HOST_MODULES_DIR;
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

let ok = false;
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
  const res = await fetch(`${base}/api/v1/hello.say`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.text();
  console.log(`hello.say -> ${res.status} ${body}`);
  ok = res.status === 200;
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(root, { recursive: true, force: true });
}
const pluginLines = log.split("\n").filter((l) => /plugin|Could not resolve/.test(l));
if (pluginLines.length > 0) console.log(pluginLines.join("\n"));
process.exit(ok ? 0 : 1);
