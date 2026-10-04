#!/usr/bin/env node
// Probe (found while fixing B-671): does `nooklet restore --force` survive a stale
// `graph.sqlite-wal` left next to the graph it overwrites? A server killed hard (OOM, power loss,
// `kill -9`) leaves its WAL behind; `restoreBackup` writes a new `graph.sqlite` and leaves any
// `-wal`/`-shm` where they are. SQLite does not check that a WAL belongs to the file beside it, so
// the next open may replay the OLD database's frames onto the restored one.
//
//   node tools/probes/restore-stale-wal.mjs
//
// Scratch data dir, invented fixture page, no server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "server");
const tsx = join(serverDir, "node_modules", ".bin", "tsx");
const data = mkdtempSync(join(tmpdir(), "nooklet-stale-wal-"));
const nooklet = (...args) =>
  spawnSync(tsx, ["src/cli.ts", ...args, "--data", data], {
    cwd: serverDir,
    env: { ...process.env, NOOKLET_DATA: data, NODE_ENV: "production" },
    encoding: "utf8",
  });

nooklet("graph", "create", "alpha");
const src = mkdtempSync(join(tmpdir(), "nooklet-stale-wal-src-"));
mkdirSync(join(src, "pages"));
writeFileSync(join(src, "pages", "Probe Page.md"), "- one\n- two\n");
nooklet("import", src, "--graph", "alpha");
const archive = join(data, "alpha.tar.gz");
nooklet("backup", "--graph", "alpha", "--out", archive);

// A writer that dies with its WAL un-checkpointed: drops every page and adds a table.
const db = join(data, "graphs", "alpha", "graph.sqlite");
spawnSync(process.execPath, [
  "-e",
  `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(db)});
   db.exec("PRAGMA wal_autocheckpoint=0");db.exec("CREATE TABLE junk(x)");
   const s=db.prepare("INSERT INTO junk VALUES (?)");for(let i=0;i<500;i++)s.run("x".repeat(500));
   db.exec("DELETE FROM block");process.kill(process.pid,"SIGKILL")`,
]);
console.log(`stale WAL present before restore: ${existsSync(`${db}-wal`)}`);

const r = nooklet("restore", archive, "--graph", "alpha", "--force");
console.log(`restore exit ${r.status}: ${r.stdout.trim().split("\n")[0]}`);
console.log(`stale WAL present after restore: ${existsSync(`${db}-wal`)}`);

const v = nooklet("verify", "--graph", "alpha");
console.log(`verify exit ${v.status}: ${(v.stdout + v.stderr).trim().split("\n").at(-1)}`);
try {
  const ro = new DatabaseSync(db);
  const blocks = ro.prepare("SELECT count(*) AS n FROM block").get().n;
  const junk = ro.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='junk'").get().n;
  console.log(`after restore: blocks=${blocks} (backup had 2), junk table present=${junk === 1}`);
  ro.close();
} catch (err) {
  console.log(`after restore: database unreadable: ${err.message}`);
}
