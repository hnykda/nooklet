/**
 * B-737 / ADR 036: does schema migration 9 key every asset of a realistically imported graph, and
 * does the real server then serve each one only with its key?
 *
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/asset-keys/migrate-v8.ts [scratch-dir]
 *
 * 1. Builds a Logseq file graph in a scratch dir: the e2e fixture graph (`e2e/fixtures/logseq-graph`)
 *    plus 300 generated pictures referenced from a page and from journals — the shape of a phone
 *    photo dump. Never the owner's graph.
 * 2. `nooklet import` (the real CLI) into a fresh data dir; counts how many asset ids share their
 *    millisecond with another one — B-737's "consecutive ids" problem, on this machine.
 * 3. Turns the result back into a version-8 database (drops `asset.url_key`, `user_version = 8`,
 *    forgets migration 9) — the only schema difference between 8 and 9.
 * 4. `nooklet verify` opens it, which runs migration 9, and checks rebuild parity.
 * 5. Every asset now has a distinct 22-character key.
 * 6. `nooklet serve`, then per asset: no key → 404, a wrong key → 404, `asset.info`'s url → 200 with
 *    the file's exact bytes, and `?w=480` with the key → 200.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverDir = join(repo, "packages/server");
const tsx = join(serverDir, "node_modules/.bin/tsx");
const cli = join(serverDir, "src/cli.ts");
const port = Number(process.env.PROBE_PORT ?? 6551);
const PICTURES = 300;

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function nooklet(data: string, ...args: string[]): string {
  return execFileSync(tsx, [cli, ...args, "--data", data], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  });
}

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "nooklet-asset-keys-probe-"));
const graph = join(scratch, "graph");
const data = join(scratch, "data");
mkdirSync(scratch, { recursive: true });

// 1. The graph.
cpSync(join(repo, "e2e/fixtures/logseq-graph"), graph, { recursive: true });
const lines: string[] = [];
for (let i = 0; i < PICTURES; i++) {
  const name = `IMG_${String(1000 + i)}.png`;
  writeFileSync(
    join(graph, "assets", name),
    png(400 + (i % 7) * 100, 300 + (i % 5) * 50, [i % 256, (i * 3) % 256, (i * 7) % 256]),
  );
  lines.push(`- ![photo ${i}](../assets/${name})`);
}
writeFileSync(join(graph, "pages", "Photo Dump.md"), `${lines.join("\n")}\n`);
mkdirSync(join(graph, "journals"), { recursive: true });
writeFileSync(
  join(graph, "journals", "2026_09_30.md"),
  `- took some pictures\n  - ![a](../assets/IMG_1000.png)\n  - ![b](../assets/IMG_1001.png)\n`,
);

// 2. Import.
nooklet(data, "import", graph);
const dbPath = join(data, "graphs/default/graph.sqlite");
{
  const db = new DatabaseSync(dbPath);
  const ids = (db.prepare("SELECT id FROM asset ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
  const byMs = new Map<string, number>();
  for (const id of ids) byMs.set(id.slice(0, 9), (byMs.get(id.slice(0, 9)) ?? 0) + 1);
  const shared = [...byMs.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  console.log(`imported ${ids.length} assets; ${shared} share a millisecond with another`);

  // 3. Back to version 8.
  db.exec("ALTER TABLE asset DROP COLUMN url_key");
  db.exec("PRAGMA user_version = 8");
  db.exec("DELETE FROM schema_migration WHERE version >= 9");
  db.close();
}

// 4. Migrate (opening runs it) and verify.
console.log(nooklet(data, "verify").trim());

// 5. Keys.
const db = new DatabaseSync(dbPath, { readOnly: true });
const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const rows = db.prepare("SELECT id, ext, url_key FROM asset").all() as Array<{
  id: string;
  ext: string;
  url_key: string;
}>;
db.close();
const good = rows.filter((r) => /^[A-Za-z0-9_-]{22}$/.test(r.url_key)).length;
const distinct = new Set(rows.map((r) => r.url_key)).size;
console.log(
  `schema ${version}; ${rows.length} assets, ${good} with a 22-char key, ${distinct} distinct`,
);
if (version !== 9 || good !== rows.length || distinct !== rows.length) process.exit(1);

// 6. Serve.
const tokenOut = nooklet(data, "token", "create", "--label", "asset-keys-probe", "--scope", "read");
const token = /nk_[A-Za-z0-9_-]+/.exec(tokenOut)?.[0];
if (!token) throw new Error(`no token in: ${tokenOut.slice(0, 80)}`);
const server = spawn(tsx, [cli, "serve", "--data", data, "--port", String(port)], {
  cwd: serverDir,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}/g/default`;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  const info = (await (
    await fetch(`${base}/api/v1/asset.info`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: rows.map((r) => r.id).slice(0, 500) }),
    })
  ).json()) as { assets: Array<{ id: string; url: string }> };
  const urlOf = new Map(info.assets.map((a) => [a.id, a.url]));
  const tally = { bare404: 0, wrong404: 0, keyed200: 0, sameBytes: 0, variant200: 0 };
  for (const r of rows) {
    const bare = `${base}/assets/${r.id}.${r.ext}`;
    if ((await fetch(bare)).status === 404) tally.bare404++;
    if ((await fetch(`${bare}?k=${"A".repeat(22)}`)).status === 404) tally.wrong404++;
    const res = await fetch(`${base}${urlOf.get(r.id)}`);
    if (res.status === 200) tally.keyed200++;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.equals(readFileSync(join(data, "graphs/default/assets", `${r.id}.${r.ext}`)))) {
      tally.sameBytes++;
    }
    if ((await fetch(`${base}${urlOf.get(r.id)}&w=480`)).status === 200) tally.variant200++;
  }
  console.log(`served ${rows.length}:`, tally);
  if (Object.values(tally).some((n) => n !== rows.length)) process.exitCode = 1;
} finally {
  server.kill();
}
console.log(`scratch: ${scratch}`);
