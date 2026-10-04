/** Builds zip files for tests, including hostile ones a well-behaved writer never would. */

import { writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { crc32, ZipStoreWriter } from "@nooklet/core";

export interface RawEntry {
  name: string;
  data: Uint8Array | string;
  deflate?: boolean;
  /** Unix mode (e.g. `0o120777` for a symlink). */
  mode?: number;
  /** Lie about the unpacked size in both headers. */
  declaredSize?: number;
  /** Leave the UTF-8 name flag off, as macOS's `zip` and Finder do. */
  noUtf8Flag?: boolean;
}

/** A zip with arbitrary names, deflate, modes and declared sizes. */
export function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data) : Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const size = e.declaredSize ?? data.length;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.noUtf8Flag ? 0 : 1 << 11, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.noUtf8Flag ? 0 : 1 << 11, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A zip the way the browser client writes one (`ZipStoreWriter`). */
export function storeZip(files: Record<string, string | Uint8Array>): Buffer {
  const w = new ZipStoreWriter();
  const parts: Uint8Array[] = [];
  for (const [name, data] of Object.entries(files)) {
    parts.push(...w.add(name, typeof data === "string" ? new TextEncoder().encode(data) : data));
  }
  parts.push(w.finish());
  return Buffer.concat(parts);
}

export function writeZip(path: string, bytes: Buffer): string {
  writeFileSync(path, bytes);
  return path;
}

/** A tiny fixture graph (invented content): two pages, a journal, a config, an asset. */
export function fixtureGraphFiles(prefix = ""): Record<string, string | Uint8Array> {
  return {
    [`${prefix}logseq/config.edn`]: '{:journal/page-title-format "EEE, dd.MM.yyyy"}\n',
    [`${prefix}pages/Garden plan.md`]:
      "- Sow the beans\n  id:: 6512bd43-d9ca-4c1e-9d0b-1f2e3d4c5b6a\n- See ![shed](../assets/shed.png)\n",
    [`${prefix}pages/Plánování.md`]:
      "- refers to ((6512bd43-d9ca-4c1e-9d0b-1f2e3d4c5b6a))\n- [[Seeds]]\n",
    [`${prefix}journals/2026_10_01.md`]: "- TODO water the [[Garden plan]]\n",
    [`${prefix}assets/shed.png`]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    [`${prefix}logseq/bak/pages/Garden plan.md`]: "- an old backup that must not be imported\n",
  };
}
