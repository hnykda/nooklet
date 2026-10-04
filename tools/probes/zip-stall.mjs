// Does yauzl 2.10's openReadStream finish an entry of ~830 KB on this Node? (ADR 030)
//
// Found during the in-app import's scale run (2026-10-04, Node 26.8): the stream delivered
// 786,432 bytes (12 x 64 KiB) of an 830,130-byte entry, then nothing — no data, no error, no end.
// The importer stopped using yauzl's streams (`packages/server/src/importer/zip.ts#readEntryData`).
// Run: node tools/probes/zip-stall.mjs   -> prints "ended" or "STALLED after N bytes".
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const yauzl = require("yauzl");

const data = randomBytes(830_000);
const packed = deflateRawSync(data);
const name = Buffer.from("assets/pic.png");
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);
local.writeUInt16LE(8, 8);
local.writeUInt32LE(packed.length, 18);
local.writeUInt32LE(data.length, 22);
local.writeUInt16LE(name.length, 26);
const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(8, 10);
central.writeUInt32LE(packed.length, 20);
central.writeUInt32LE(data.length, 24);
central.writeUInt16LE(name.length, 28);
const cdOffset = 30 + name.length + packed.length;
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(46 + name.length, 12);
end.writeUInt32LE(cdOffset, 16);
const path = join(mkdtempSync(join(tmpdir(), "zip-stall-")), "a.zip");
writeFileSync(path, Buffer.concat([local, name, packed, central, name, end]));

yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
  if (err) throw err;
  zip.on("entry", (entry) => {
    zip.openReadStream(entry, (err2, stream) => {
      if (err2) throw err2;
      let n = 0;
      const timer = setTimeout(() => {
        console.log(`STALLED after ${n} of ${data.length} bytes (node ${process.version})`);
        process.exit(1);
      }, 5000);
      stream.on("data", (c) => {
        n += c.length;
      });
      stream.on("end", () => {
        clearTimeout(timer);
        console.log(`ended: ${n} bytes (node ${process.version})`);
        process.exit(0);
      });
    });
  });
  zip.readEntry();
});
