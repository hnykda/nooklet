#!/usr/bin/env node
// Streaming-backup probe (docs/progress/streaming-backup.md): peak RSS of `nooklet backup` and
// `nooklet restore` on a synthetic graph of a production-like shape, run as ONE node process
// (an esbuild bundle like the shipped image, no tsx wrapper).
//
//   node tools/probes/backup-memory.mjs <scratch-dir> [assetMiB=350] [pages=1500]
//
// The first run builds <scratch-dir>/data (a Logseq-shaped import into graph "default" plus
// incompressible random-byte assets, like photos) and reuses it afterwards. Every run backs the
// graph up, restores it into graph "back" of a second data dir, prints both peak RSS figures and
// runs `verify` on the restored graph. Invented content only; no server, no port.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [scratch, assetMiBArg, pagesArg] = process.argv.slice(2);
if (!scratch) {
  console.error("usage: backup-memory.mjs <scratch-dir> [assetMiB] [pages]");
  process.exit(2);
}
const assetMiB = Number(assetMiBArg ?? 350);
const pages = Number(pagesArg ?? 1500);
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "server");
const data = join(scratch, "data");
const graph = join(data, "graphs", "default");
const heapFlag = process.env.PROBE_HEAP ?? "--max-old-space-size=128";

// Production runs an esbuild bundle (`deploy/docker/Dockerfile` -> apps/desktop/build-sidecar.mjs),
// not tsx: under tsx the CLI costs ~190 MiB RSS just to print --version, which would swamp the
// number being measured. Bundle this checkout's cli.ts the same way, or use PROBE_SERVER_MJS
// (e.g. a bundle of an older commit, for before/after).
let serverMjs = process.env.PROBE_SERVER_MJS;
if (!serverMjs) {
  const require = createRequire(join(serverDir, "..", "..", "apps", "desktop", "package.json"));
  const esbuild = require("esbuild");
  serverMjs = join(scratch, "server.mjs");
  mkdirSync(scratch, { recursive: true });
  esbuild.buildSync({
    entryPoints: [join(serverDir, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: serverMjs,
    external: ["sqlite-vec"],
    logLevel: "warning",
    banner: {
      js: "import{createRequire as __nooklet_cr}from'node:module';const require=__nooklet_cr(import.meta.url);",
    },
  });
}
const cli = [serverMjs];

/** Run the CLI as a single node process under /usr/bin/time -l (macOS) / -v (GNU). */
function nooklet(label, ...args) {
  const isMac = process.platform === "darwin";
  const r = spawnSync(
    "/usr/bin/time",
    [isMac ? "-l" : "-v", process.execPath, heapFlag, ...cli, ...args],
    { cwd: serverDir, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
  );
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${label} failed (exit ${r.status})`);
  }
  // macOS reports bytes, GNU time reports KiB.
  const mac = /(\d+)\s+maximum resident set size/.exec(r.stderr);
  const gnu = /Maximum resident set size \(kbytes\): (\d+)/.exec(r.stderr);
  const rssMiB = mac ? Number(mac[1]) / 2 ** 20 : Number(gnu?.[1] ?? Number.NaN) / 1024;
  const real = /([\d.]+) real/.exec(r.stderr)?.[1] ?? /Elapsed.*: (\S+)/.exec(r.stderr)?.[1];
  console.log(`${label}: peak RSS ${rssMiB.toFixed(1)} MiB, wall ${real}s`);
  return r.stdout;
}

function dirBytes(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += statSync(join(e.parentPath, e.name)).size;
  }
  return n;
}

if (!existsSync(join(graph, "graph.sqlite"))) {
  // A Logseq-shaped source: many pages of long-ish blocks, so the db is tens of MB of real rows,
  // op log and FTS, not a filler blob.
  const src = join(scratch, "logseq-src");
  mkdirSync(join(src, "pages"), { recursive: true });
  for (let p = 0; p < pages; p++) {
    const lines = [];
    for (let b = 0; b < 40; b++) {
      lines.push(
        `- block ${b} of page ${p} [[Page ${(p * 7 + b) % pages}]] ${randomBytes(90).toString("base64")}`,
      );
    }
    writeFileSync(join(src, "pages", `Page ${p}.md`), `${lines.join("\n")}\n`);
  }
  execFileSync(process.execPath, [...cli, "import", src, "--data", data], {
    cwd: serverDir,
    stdio: "ignore",
    env: { ...process.env, NODE_ENV: "production" },
  });
  // Photo-like assets: incompressible, ~2 MiB each, flat under assets/ like asset.upload writes.
  const assets = join(graph, "assets");
  mkdirSync(assets, { recursive: true });
  const n = Math.ceil(assetMiB / 2);
  for (let i = 0; i < n; i++) {
    const id = createHash("sha1").update(String(i)).digest("hex").slice(0, 14);
    writeFileSync(join(assets, `${id}.jpg`), randomBytes(2 * 2 ** 20));
  }
}

const dbMiB = statSync(join(graph, "graph.sqlite")).size / 2 ** 20;
const assetsMiBReal = dirBytes(join(graph, "assets")) / 2 ** 20;
console.log(
  `graph: db ${dbMiB.toFixed(1)} MiB + assets ${assetsMiBReal.toFixed(1)} MiB (${readdirSync(join(graph, "assets")).length} files), node ${heapFlag}`,
);

const out = join(scratch, "big.tar.gz");
rmSync(out, { force: true });
nooklet("backup", "backup", "--data", data, "--out", out);
console.log(`archive: ${(statSync(out).size / 2 ** 20).toFixed(1)} MiB`);

const data2 = join(scratch, "data-restore");
rmSync(data2, { recursive: true, force: true });
nooklet("restore", "restore", out, "--data", data2, "--graph", "back");
const restoredMiB = dirBytes(join(data2, "graphs", "back")) / 2 ** 20;
console.log(`restored: ${restoredMiB.toFixed(1)} MiB on disk`);
const verify = execFileSync(
  process.execPath,
  [...cli, "verify", "--data", data2, "--graph", "back"],
  { cwd: serverDir, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
);
console.log(`verify: ${verify.trim().split("\n")[0]}`);
