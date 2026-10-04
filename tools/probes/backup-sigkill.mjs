#!/usr/bin/env node
// Streaming-backup probe (docs/progress/streaming-backup.md): does a backup killed with SIGKILL
// half-way through leave anything under the archive's final name?
//
//   node tools/probes/backup-sigkill.mjs <scratch-dir>
//
// Builds a graph from the committed v1 fixture archive plus 1 GiB of sparse "assets" (no disk
// used; reading them still costs real gzip work, so the backup runs for seconds), starts
// `nooklet backup --out <final>`, waits until the partial archive has bytes in it, kills the
// process with SIGKILL, and reports what is left in the output directory. Then a clean backup
// to the same path, to show the leftover does not get in its way.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: backup-sigkill.mjs <scratch-dir>");
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const esbuild = createRequire(join(repo, "apps", "desktop", "package.json"))("esbuild");
const serverMjs = join(scratch, "server-sigkill.mjs");
mkdirSync(scratch, { recursive: true });
esbuild.buildSync({
  entryPoints: [join(repo, "packages", "server", "src", "cli.ts")],
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

const data = join(scratch, "sigkill-data");
rmSync(data, { recursive: true, force: true });
const fixture = join(repo, "packages", "server", "src", "backup", "fixtures", "v1-c9d993b.tar.gz");
spawnSync(process.execPath, [serverMjs, "restore", fixture, "--data", data], { stdio: "ignore" });
const assets = join(data, "graphs", "default", "assets");
for (let i = 0; i < 100; i++) {
  const f = join(assets, `sparse${String(i).padStart(3, "0")}.bin`);
  writeFileSync(f, "");
  truncateSync(f, 10 * 2 ** 20);
}

const outDir = join(scratch, "sigkill-out");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);
const final = join(outDir, "nightly.tar.gz");
const child = spawn(process.execPath, [serverMjs, "backup", "--data", data, "--out", final], {
  stdio: "ignore",
});
const partialBytes = () => {
  for (const n of readdirSync(outDir)) {
    if (n.includes(".partial-")) return statSync(join(outDir, n)).size;
  }
  return 0;
};
const t0 = Date.now();
// Zeros deflate ~1000:1, so 1 GiB of sparse assets is ~1 MiB of archive: 256 KiB is mid-way.
while (partialBytes() < 256 * 1024) {
  if (Date.now() - t0 > 60_000 || child.exitCode !== null) {
    console.error("backup finished or stalled before it could be killed mid-write");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 20));
}
const at = partialBytes();
child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));
console.log(`killed with SIGKILL after ${at} bytes of the partial archive`);
console.log(`final path exists: ${existsSync(final)}`);
console.log(`left in the output dir: ${JSON.stringify(readdirSync(outDir))}`);

const again = spawnSync(process.execPath, [serverMjs, "backup", "--data", data, "--out", final], {
  encoding: "utf8",
});
console.log(`clean re-run: exit ${again.status}, final path exists: ${existsSync(final)}`);
const listing = spawnSync("tar", ["tzf", final], { encoding: "utf8" });
console.log(`tar tzf: ${listing.stdout.trim().split("\n").length} entries, exit ${listing.status}`);
