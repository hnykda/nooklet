// Turns the half-block QR that `nooklet pair` prints into an image, as a dark-background terminal
// shows it (a full block is a LIGHT cell: the terminal paints the glyph in its light foreground),
// so `decode.swift` can check it. Reads stdin, writes a binary PPM to stdout, 8 px per module.
//
//   nooklet pair --link https://n.example.ts.net | node terminal-to-ppm.mjs > qr.ppm
//   sips -s format png qr.ppm --out qr.png && swift decode.swift qr.png
//
// Finding (2026-10-04): Core Image decodes the payload from both renderings, the dark-terminal one
// and (`--light-terminal`) the colour-inverted one a light-background terminal shows. Whether a
// phone camera reads the inverted one is not verified; see docs/progress/qr-pairing.md.
import { readFileSync } from "node:fs";

const invert = process.argv.includes("--light-terminal");
const lines = readFileSync(0, "utf8")
  .split("\n")
  .filter((l) => /^[█▀▄ ]+$/.test(l) && /[█▀▄]/.test(l));
const width = Math.max(...lines.map((l) => [...l].length));
const rows = [];
for (const line of lines) {
  const chars = [...line.padEnd(width, " ")];
  rows.push(chars.map((c) => c === "█" || c === "▀")); // top half light?
  rows.push(chars.map((c) => c === "█" || c === "▄")); // bottom half light?
}
const S = 8;
const pad = 4; // extra quiet zone, light
const W = (width + 2 * pad) * S;
const H = (rows.length + 2 * pad) * S;
const px = Buffer.alloc(W * H * 3, 255);
rows.forEach((row, y) =>
  row.forEach((light, x) => {
    const v = light !== invert ? 255 : 0;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const i = (((y + pad) * S + dy) * W + (x + pad) * S + dx) * 3;
        px[i] = px[i + 1] = px[i + 2] = v;
      }
  }),
);
process.stdout.write(Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]));
