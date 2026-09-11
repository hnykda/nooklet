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
 * - **`web/`** — the built client, which the server serves from its own origin.
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
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(here, "sidecar");
const require = createRequire(join(repoRoot, "packages", "server", "index.js"));

function mib(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MiB`;
}

/** esbuild's JS API spawns a per-platform executable that ships in its own package. */
function findEsbuildBinary() {
  const target = `${process.platform}-${process.arch}`;
  const store = join(repoRoot, "node_modules", ".pnpm");
  const candidates = readdirSync(store)
    .filter((name) => name.startsWith(`@esbuild+${target}@`))
    .map((name) => join(store, name, "node_modules", "@esbuild", target, "bin", "esbuild"))
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
  const target = `${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
  const name = `node-v${version}-${target}`;
  const cacheDir = join(here, ".cache");
  const extracted = join(cacheDir, name, "bin", "node");
  if (existsSync(extracted)) return extracted;

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://nodejs.org/dist/v${version}/${name}.tar.xz`;
  console.log(`downloading ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download Node ${version} for ${target}: ${res.status}`);
  const archive = join(cacheDir, `${name}.tar.xz`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const r = spawnSync("tar", ["-xJf", archive, "-C", cacheDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("could not extract the Node tarball");
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
  // The bundle is ESM but some dependencies still reach for `require`; give them a real one.
  banner: {
    js: "import{createRequire as __nooklet_cr}from'node:module';const require=__nooklet_cr(import.meta.url);",
  },
});
console.log(`server.mjs        ${mib(join(outDir, "server.mjs"))}`);

// 2. The Node runtime — the OFFICIAL build, not whatever is on PATH.
// Homebrew's `node` is a ~50 kB shim that dynamically links `libnode.dylib` and a dozen other
// Homebrew dylibs by absolute path; copied into an app bundle it dies with
// "Library not loaded: @rpath/libnode.147.dylib". The nodejs.org builds are self-contained.
const nodeBin = await officialNodeBinary(NODE_VERSION);
cpSync(nodeBin, join(outDir, "node"));
chmodSync(join(outDir, "node"), 0o755);
console.log(`node              ${mib(join(outDir, "node"))}  (official v${NODE_VERSION})`);

// 3. sqlite-vec's native extension.
const vecPath = require("sqlite-vec").getLoadablePath();
cpSync(vecPath, join(outDir, "vec0.dylib"));
console.log(`vec0.dylib        ${mib(join(outDir, "vec0.dylib"))}`);

// 4. esbuild's per-platform binary, for runtime plugin bundling.
// Located by walking the store rather than `require.resolve`: pnpm isolates the per-platform
// package so it is not resolvable from the server's own dependency graph, only from esbuild's.
const esbuildBin = findEsbuildBinary();
cpSync(esbuildBin, join(outDir, "esbuild"));
chmodSync(join(outDir, "esbuild"), 0o755);
console.log(`esbuild           ${mib(join(outDir, "esbuild"))}`);

// 5. The web client. Built first if missing, since a desktop app with no UI is not useful.
const webDist = join(repoRoot, "apps", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  console.log("building the web client first…");
  const r = spawnSync("pnpm", ["--filter", "@nooklet/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("web client build failed");
}
cpSync(webDist, join(outDir, "web"), { recursive: true });
console.log("web/              (client build)");

console.log(`\nsidecar ready at ${outDir}`);
