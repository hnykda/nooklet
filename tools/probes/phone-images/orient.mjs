// Adds an EXIF APP1 segment with Orientation=<n> right after SOI of a JPEG (like an iPhone
// portrait photo: landscape pixels + Orientation 6).
import { readFileSync, writeFileSync } from "node:fs";

const [, , inp, out, n] = process.argv;
const jpg = readFileSync(inp);
const tiff = Buffer.from([
  0x4d,
  0x4d,
  0x00,
  0x2a,
  0x00,
  0x00,
  0x00,
  0x08, // big-endian TIFF, IFD at 8
  0x00,
  0x01, // 1 entry
  0x01,
  0x12,
  0x00,
  0x03,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  Number(n),
  0x00,
  0x00, // Orientation SHORT
  0x00,
  0x00,
  0x00,
  0x00, // next IFD
]);
const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
const len = Buffer.alloc(2);
len.writeUInt16BE(payload.length + 2);
writeFileSync(
  out,
  Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpg.subarray(2)]),
);
