/**
 * Does a browser replica really carry the client-only `block_dated` index? (repair-agenda,
 * 2026-09-13.) The unit test runs `WorkerDb` on Node's SQLite; this checks the real thing: a
 * persistent Chromium profile that has loaded the app, its OPFS database copied out from a page on
 * the same origin that does not start the DB worker (`/healthz`), and its schema read back with
 * node:sqlite.
 *
 * `opfs-sahpool` keeps each database in an opaque file with a 4096-byte header of its own before
 * the SQLite file proper (sqlite-wasm's `HEADER_OFFSET_DATA`); the copy drops it.
 *
 * Usage: node tools/probes/replica-index-opfs.mjs <baseURL> <profileDir that has loaded the app> <outDir>
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const [baseURL, profileDir, outDir] = process.argv.slice(2);
if (!baseURL || !profileDir || !outDir) {
  console.error("usage: replica-index-opfs.mjs <baseURL> <profileDir> <outDir>");
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  serviceWorkers: "block",
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(`${baseURL}/healthz`);
const files = await page.evaluate(async () => {
  const out = [];
  async function walk(dir, path) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") await walk(handle, `${path}${name}/`);
      else {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        const magic = new TextDecoder().decode(bytes.slice(4096, 4096 + 15));
        if (magic !== "SQLite format 3") continue;
        // Base64 in chunks: a 10 MB array of numbers through `evaluate` takes minutes.
        let binary = "";
        for (let i = 4096; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        out.push({ name: `${path}${name}`, data: btoa(binary) });
      }
    }
  }
  await walk(await navigator.storage.getDirectory(), "/");
  return out;
});
await ctx.close();

for (const [i, f] of files.entries()) {
  const path = join(outDir, `replica-${i}.sqlite`);
  writeFileSync(path, Buffer.from(f.data, "base64"));
  const db = new DatabaseSync(path, { readOnly: true });
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'block'")
    .all()
    .map((r) => r.name);
  const blocks = db.prepare("SELECT count(*) AS n FROM block").get().n;
  console.log(JSON.stringify({ opfsFile: f.name, copy: path, blocks, blockIndexes: indexes }));
  db.close();
}
if (files.length === 0) console.log("no SQLite database in this origin's OPFS");
