#!/usr/bin/env node
// B-671 probe: per-graph backup -> mutate -> restore round trip through the real CLI, in a scratch
// data dir holding TWO graphs. Settles: does `restore --graph alpha --force` bring back exactly
// alpha's backed-up state, leave `default` byte-for-byte alone in content, and leave both graphs
// passing `verify`?
//
//   node tools/probes/restore-per-graph.mjs
//
// Uses only invented fixture pages, a fresh mkdtemp data dir, and no server/port.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "server");
const tsx = join(serverDir, "node_modules", ".bin", "tsx");
const data = mkdtempSync(join(tmpdir(), "nooklet-restore-probe-"));

function nooklet(...args) {
  const out = execFileSync(tsx, ["src/cli.ts", ...args, "--data", data], {
    cwd: serverDir,
    env: { ...process.env, NOOKLET_DATA: data, NODE_ENV: "production" },
    encoding: "utf8",
  });
  console.log(`$ nooklet ${args.join(" ")}`);
  if (!args.includes("import")) process.stdout.write(out.replace(data, "<data>"));
  return out;
}

function logseq(...pages) {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-restore-probe-src-"));
  mkdirSync(join(dir, "pages"));
  for (const p of pages)
    writeFileSync(join(dir, "pages", `${p}.md`), `- first\n- second on ${p}\n`);
  return dir;
}

/** Content fingerprint: page names and block count, read-only. */
function state(graph) {
  const db = new DatabaseSync(join(data, "graphs", graph, "graph.sqlite"), { readOnly: true });
  try {
    const pages = db
      .prepare("SELECT name FROM page WHERE journal_day IS NULL ORDER BY name")
      .all()
      .map((r) => r.name);
    const blocks = db.prepare("SELECT count(*) AS n FROM block").get().n;
    const ops = db.prepare("SELECT count(*) AS n FROM op").get().n;
    return JSON.stringify({ pages, blocks, ops });
  } finally {
    db.close();
  }
}

nooklet("graph", "create", "alpha", "--label", "Alpha");
nooklet("import", logseq("Garden Plan", "Reading List"));
nooklet("import", logseq("Alpha Kept One", "Alpha Kept Two"), "--graph", "alpha");
const defaultBefore = state("default");
const alphaBackedUp = state("alpha");
console.log(`default: ${defaultBefore}\nalpha:   ${alphaBackedUp}`);

const archive = join(data, "alpha-nightly.tar.gz");
nooklet("backup", "--graph", "alpha", "--out", archive);

nooklet("import", logseq("Alpha Added Later"), "--graph", "alpha");
const alphaMutated = state("alpha");
console.log(`alpha after mutation: ${alphaMutated}`);

nooklet("restore", archive, "--graph", "alpha", "--force");
const alphaRestored = state("alpha");
const defaultAfter = state("default");
console.log(`alpha after restore:   ${alphaRestored}\ndefault after restore: ${defaultAfter}`);

nooklet("verify", "--graph", "alpha");
nooklet("verify");

const checks = {
  "alpha changed by the mutation": alphaMutated !== alphaBackedUp,
  "alpha restored to the backed-up state": alphaRestored === alphaBackedUp,
  "default untouched": defaultAfter === defaultBefore,
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);
if (!Object.values(checks).every(Boolean)) process.exit(1);
