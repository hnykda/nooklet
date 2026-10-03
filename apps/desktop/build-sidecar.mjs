/**
 * Assembles everything the desktop app needs to run its OWN nooklet server, into
 * `apps/desktop/sidecar/`. Tauri ships that directory as an app resource; `src-tauri/src/main.rs`
 * launches it on startup.
 *
 * What has to be in there, and why each piece is awkward:
 *
 * - **`server.mjs`** — the whole server, esbuild-bundled to a single file (~2 MB). Bundling is
 *   what removes the `node_modules` dependency; everything below is a consequence of that.
 * - **`node`** — a copy of the Node runtime. The server needs `node:sqlite` with extension
 *   loading, which rules out Bun on macOS (ADR 014) and means a real Node binary. This is the
 *   overwhelming majority of the bundle size, and it is the price of the app being self-contained.
 * - **`vec0.dylib`** — sqlite-vec's native extension. It normally resolves through `node_modules`,
 *   so the server reads `NOOKLET_SQLITE_VEC_PATH` instead (`embeddings/vec-loader.ts`). Without
 *   this, semantic and hybrid search silently degrade to keyword.
 * - **`esbuild`** — the per-platform binary esbuild's JS API shells out to, used at runtime to
 *   bundle user plugins. Pointed at with `ESBUILD_BINARY_PATH`, the documented escape hatch.
 * - **`web/`** — the client, built by this script from this checkout every time (B-337), which
 *   the server serves from its own origin.
 * - **`plugins/`** — the built-in plugins (word-count, mermaid, daily-summary), ALREADY bundled
 *   (B-180). `nooklet serve` bundles the repo's plugin sources at startup, resolving their
 *   `@nooklet/plugin-api`/`zod` imports through `node_modules` and writing into their directories;
 *   the sidecar has no `node_modules`, and its directory is inside the signed app, read-only when
 *   run from the disk image. So they are bundled here, by the loader's own bundler
 *   (`packages/server/src/plugins/bundled.ts`), and `server.mjs` is told where they are through
 *   `NOOKLET_BUNDLED_PLUGINS_DIR` — set by its own first line, so the sidecar needs nothing from
 *   `main.rs` to find them. Before this the app had no `page.wordcount` op or MCP tool, and
 *   Settings → Plugins was empty.
 * - **`host-modules/`** — `@nooklet/plugin-api`, `@nooklet/core`, `zod` and `hono` as one ESM file
 *   each, for the plugins a USER puts in `<data>/plugins`, which are still bundled at runtime and
 *   import those from the host (B-336). `NOOKLET_HOST_MODULES_DIR`, set by the same first line,
 *   points the loader at them.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(here, "sidecar");
const require = createRequire(join(repoRoot, "packages", "server", "index.js"));

function mib(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MiB`;
}

/** Platform-specific names for everything native the sidecar ships. */
const PLATFORM = {
  /** What `sqlite-vec`'s loadable extension is called here. */
  vecExt: { darwin: "dylib", linux: "so", win32: "dll" }[process.platform] ?? "so",
  /** Executables need the suffix on Windows or `Command::new` will not find them. */
  exe: process.platform === "win32" ? ".exe" : "",
  /** How nodejs.org names its archives, and which unpacker to use. */
  nodeOs: { darwin: "darwin", linux: "linux", win32: "win" }[process.platform] ?? "linux",
  nodeArch: process.arch === "arm64" ? "arm64" : "x64",
};

/** esbuild's JS API spawns a per-platform executable that ships in its own package. */
function findEsbuildBinary() {
  const target = `${process.platform}-${process.arch}`;
  const store = join(repoRoot, "node_modules", ".pnpm");
  const candidates = readdirSync(store)
    .filter((name) => name.startsWith(`@esbuild+${target}@`))
    .map((name) =>
      join(store, name, "node_modules", "@esbuild", target, "bin", `esbuild${PLATFORM.exe}`),
    )
    .filter((p) => existsSync(p));
  const found = candidates[0];
  if (!found) {
    throw new Error(
      `no esbuild binary for ${target} under ${store} — runtime plugin bundling would not work`,
    );
  }
  return found;
}

/** Matches the runtime this repo develops against; `node:sqlite` and its extension loading are
 * the reason the version matters (ADR 014). */
const NODE_VERSION = process.versions.node;

/** Downloads (and caches) the official Node tarball for this platform and returns the `node`
 * inside it. */
async function officialNodeBinary(version) {
  const target = `${PLATFORM.nodeOs}-${PLATFORM.nodeArch}`;
  const name = `node-v${version}-${target}`;
  // Windows ships a zip with node.exe at the root; the unix builds ship a tarball with bin/node.
  const isZip = PLATFORM.nodeOs === "win";
  const cacheDir = join(here, ".cache");
  const extracted = isZip ? join(cacheDir, name, "node.exe") : join(cacheDir, name, "bin", "node");
  if (existsSync(extracted)) return extracted;

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://nodejs.org/dist/v${version}/${name}.${isZip ? "zip" : "tar.xz"}`;
  console.log(`downloading ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download Node ${version} for ${target}: ${res.status}`);
  const archive = join(cacheDir, `${name}.${isZip ? "zip" : "tar.xz"}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // `tar` and `unzip`/Expand-Archive are present on every GitHub runner and every dev machine
  // this targets; bundling an extractor would be more moving parts than it is worth.
  const r = isZip
    ? spawnSync("unzip", ["-q", "-o", archive, "-d", cacheDir], { stdio: "inherit" })
    : spawnSync("tar", ["-xJf", archive, "-C", cacheDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("could not extract the Node archive");
  if (!existsSync(extracted)) throw new Error(`no node binary at ${extracted}`);
  return extracted;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. The server, as one file.
await esbuild.build({
  entryPoints: [join(repoRoot, "packages", "server", "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(outDir, "server.mjs"),
  // `sqlite-vec`'s JS is dropped entirely: the dylib path comes from the environment instead, so
  // nothing needs to resolve the package at runtime.
  external: ["sqlite-vec"],
  logLevel: "warning",
  // The bundle is ESM but some dependencies still reach for `require`; give them a real one. And
  // the built-in plugins are in `plugins/` beside this file, the modules a user's plugin imports
  // from the host in `host-modules/` (step 6) — unless someone set the variables already.
  banner: {
    js: [
      "import{createRequire as __nooklet_cr}from'node:module';const require=__nooklet_cr(import.meta.url);",
      "import{fileURLToPath as __nooklet_fp}from'node:url';",
      "process.env.NOOKLET_BUNDLED_PLUGINS_DIR??=__nooklet_fp(new URL('./plugins',import.meta.url));",
      "process.env.NOOKLET_HOST_MODULES_DIR??=__nooklet_fp(new URL('./host-modules',import.meta.url));",
    ].join(""),
  },
});
console.log(`server.mjs        ${mib(join(outDir, "server.mjs"))}`);

// 2. The Node runtime — the OFFICIAL build, not whatever is on PATH.
// Homebrew's `node` is a ~50 kB shim that dynamically links `libnode.dylib` and a dozen other
// Homebrew dylibs by absolute path; copied into an app bundle it dies with
// "Library not loaded: @rpath/libnode.147.dylib". The nodejs.org builds are self-contained.
const nodeBin = await officialNodeBinary(NODE_VERSION);
const nodeOut = join(outDir, `node${PLATFORM.exe}`);
cpSync(nodeBin, nodeOut);
chmodSync(nodeOut, 0o755);
console.log(`node              ${mib(nodeOut)}  (official v${NODE_VERSION})`);

// 3. sqlite-vec's native extension.
const vecPath = require("sqlite-vec").getLoadablePath();
const vecOut = join(outDir, `vec0.${PLATFORM.vecExt}`);
cpSync(vecPath, vecOut);
console.log(`vec0.${PLATFORM.vecExt.padEnd(12)}${mib(vecOut)}`);

// 4. esbuild's per-platform binary, for runtime plugin bundling.
// Located by walking the store rather than `require.resolve`: pnpm isolates the per-platform
// package so it is not resolvable from the server's own dependency graph, only from esbuild's.
const esbuildBin = findEsbuildBinary();
const esbuildOut = join(outDir, `esbuild${PLATFORM.exe}`);
cpSync(esbuildBin, esbuildOut);
chmodSync(esbuildOut, 0o755);
console.log(`esbuild           ${mib(esbuildOut)}`);

// 5. The web client, built NOW from this checkout's sources — every time, never "if missing".
// `apps/web/dist` is rewritten by every e2e run and every `vite build`, from whatever tree the
// checkout had then; this step used to build only when `dist/index.html` was absent and otherwise
// copy what was there, so a `desktop:build` after switching branches (or after an e2e run on
// another tree state) shipped an older client beside a newer server with nothing to say so
// (B-337). CI starts from a fresh checkout and never saw it. Vite takes seconds;
// `e2e/global-setup.ts` rebuilds for the same reason. `tools/probes/sidecar-web-freshness.mjs`
// plants a stale `dist` and checks it does not ship.
const webDist = join(repoRoot, "apps", "web", "dist");
console.log("building the web client…");
const webBuild = spawnSync("pnpm", ["--filter", "@nooklet/web", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (webBuild.status !== 0) throw new Error("web client build failed");
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error(`the web client build left no ${join(webDist, "index.html")}`);
}
cpSync(webDist, join(outDir, "web"), { recursive: true });
console.log("web/              (client build)");

// 6. The built-in plugins, bundled now because the sidecar cannot bundle them (see the header).
// Through `tsx`, because the packaging module is the server's own TypeScript and imports its
// siblings as `.js`, which Node's built-in type stripping does not map to `.ts`.
const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const { packageBundledPlugins, packageHostModules } = await tsImport(
  pathToFileURL(join(repoRoot, "packages", "server", "src", "plugins", "bundled.ts")).href,
  import.meta.url,
);
// mermaid is NOT bundled into the mermaid plugin's client half: the web build in `web/` already
// has it (the app compiles that client half in, ADR 023), and inlining it here shipped a second
// ~12 MB copy that nothing ever loads — the app requests no `/plugins/<id>/client.*.js`. The
// served half imports the web build's own `mermaid.core` chunk by URL instead, which works because
// the sidecar serves both from one origin.
const mermaidCore = readdirSync(join(outDir, "web", "static")).filter((n) =>
  /^mermaid\.core-[\w-]+\.js$/.test(n),
);
if (mermaidCore.length !== 1) {
  throw new Error(`expected one mermaid.core chunk in the web build, found ${mermaidCore.length}`);
}
const packaged = await packageBundledPlugins(join(repoRoot, "plugins"), join(outDir, "plugins"), {
  clientImportUrls: { mermaid: `/static/${mermaidCore[0]}` },
});
for (const p of packaged) {
  const halves = [p.server && "server", p.client && "client"].filter(Boolean).join(" + ");
  console.log(`${`plugins/${p.id}`.padEnd(22)}(${halves})`);
}
// The guard against a second mermaid creeping back (a renamed import, a new specifier).
const mermaidClient = join(outDir, "plugins", "mermaid", "client.js");
if (existsSync(mermaidClient) && statSync(mermaidClient).size > 512 * 1024) {
  throw new Error(`plugins/mermaid/client.js is ${mib(mermaidClient)} — mermaid got inlined again`);
}
if (!packaged.some((p) => p.id === "word-count")) {
  throw new Error("no word-count plugin was packaged — the built-in plugins are missing");
}

// 7. What a USER's plugin imports from the host (`@nooklet/plugin-api`, `@nooklet/core`, `zod`,
// `hono`), as files. The built-ins above arrive pre-bundled, but a plugin dropped into
// `<data>/plugins` is bundled at runtime, and the loader resolved those imports through the
// server's `node_modules` — which a one-file `server.mjs` does not have, so every such plugin
// failed with `Could not resolve "@nooklet/plugin-api"` (B-336). The loader aliases to these when
// `NOOKLET_HOST_MODULES_DIR` is set, which the banner above does.
// `tools/probes/sidecar-user-plugin.mjs` runs a user plugin in a sidecar copied out of the repo.
const hostModules = await packageHostModules(join(outDir, "host-modules"));
for (const file of hostModules) {
  console.log(`${`host-modules/${file.split(/[\\/]/).pop()}`.padEnd(38)}${mib(file)}`);
}

console.log(`\nsidecar ready at ${outDir}`);
