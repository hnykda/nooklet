// Seeds the scratch server (port 6481) for the Simulator probe: a page with text blocks and an
// uploaded 4:3 image. Also writes the PNG for `simctl addmedia`.
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

function png(width, height, rgb) {
  const chunk = (type, data) => {
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
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const base = "http://127.0.0.1:6481/g/default";
const { token } = await (await fetch(`${base}/api/session`)).json();
const call = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
const img = png(1200, 900, [40, 140, 220]);
writeFileSync(new URL("./land-1200x900.png", import.meta.url), img);
writeFileSync(new URL("./tall-900x1600.png", import.meta.url), png(900, 1600, [40, 180, 90]));
const up = await call("asset.upload", {
  filename: "land.png",
  mime_type: "image/png",
  data_base64: img.toString("base64"),
});
await call("page.append", {
  page: "2026-10-04",
  markdown: `- first block\n- ${up.markdown}\n- third block`,
});
console.log(token, up.markdown);
