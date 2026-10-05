/**
 * Probe (2026-10-05, ADR 035): does the BUILT sidecar make resized pictures, with no repo
 * `node_modules` in reach? `server.mjs` loads sharp by path from `lib/node_modules/` (copied there
 * by `apps/desktop/build-sidecar.mjs`); a mistake there only shows as "variants silently off".
 *
 *   pnpm --filter @nooklet/desktop run sidecar
 *   node tools/probes/image-cache/sidecar-variants.mjs [<sidecar dir>]
 *
 * Copies the sidecar to a scratch dir, runs it with its own `node`, uploads a generated 3000×2000
 * JPEG and asks for `?w=960`. Prints what came back; exits 1 unless it is a 960-px WebP. The
 * container image runs the same directory (`deploy/docker/Dockerfile`), so the same check works
 * inside it: `docker run --entrypoint /app/node <image> /app/probe.mjs` is not needed, the Docker
 * smoke in docs/progress/image-speed.md does it over HTTP instead.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const src = process.argv[2] ?? join(repoRoot, "apps", "desktop", "sidecar");
const PORT = Number(process.env.PORT ?? 6571);
const scratch = mkdtempSync(join(tmpdir(), "nooklet-sidecar-variants-"));
const app = join(scratch, "app");
cpSync(src, app, { recursive: true });

// A noise PNG: no image library needed here, which is the point (nothing from the repo).
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([x % 256, y % 256, (x * y) % 256], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const server = spawn(
  join(app, process.platform === "win32" ? "node.exe" : "node"),
  [join(app, "server.mjs"), "serve", "--data", join(scratch, "data"), "--port", String(PORT)],
  { cwd: scratch, stdio: ["ignore", "inherit", "inherit"], env: { PATH: process.env.PATH } },
);
let code = 1;
try {
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (i > 120) throw new Error("the sidecar never answered");
    await new Promise((r) => setTimeout(r, 250));
  }
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const up = await (
    await fetch(`${base}/api/v1/asset.upload`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filename: "probe.png",
        mime_type: "image/png",
        data_base64: png(3000, 2000).toString("base64"),
      }),
    })
  ).json();
  const t0 = performance.now();
  const res = await fetch(`${base}${up.url}?w=960`);
  const body = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t0;
  // VP8/VP8L/VP8X carry the width; for lossy VP8 it is at bytes 26-27 (14 bits).
  const isWebp =
    body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP";
  const width =
    isWebp && body.subarray(12, 16).toString() === "VP8 "
      ? body.readUInt16LE(26) & 0x3fff
      : undefined;
  console.log(
    `original ${up.byte_size} B → ?w=960: ${res.status} ${res.headers.get("content-type")} ${body.length} B, width ${width}, ${ms.toFixed(0)} ms`,
  );
  const again = performance.now();
  await (await fetch(`${base}${up.url}?w=960`)).arrayBuffer();
  console.log(`second request (from the disk cache): ${(performance.now() - again).toFixed(0)} ms`);
  code = res.headers.get("content-type") === "image/webp" && width === 960 ? 0 : 1;
} finally {
  server.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}
console.log(code === 0 ? "OK: the sidecar makes variants" : "FAIL");
process.exit(code);
