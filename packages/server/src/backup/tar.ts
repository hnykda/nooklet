/**
 * A minimal, dependency-free USTAR (POSIX tar) writer/reader, gzipped via `node:zlib` — the
 * container format for `nooklet backup`/`nooklet restore` (M6, PLAN.md §15).
 *
 * Scope is deliberately narrow: regular files only, flat-ish short paths (this package's own
 * `manifest.json`, `graph.sqlite`, `assets/<14-char-id>.<ext>`), no symlinks, no GNU long-name
 * extension, no directory entries (a tar extractor creates parent directories from a file's own
 * path, which is all `restoreBackup` needs). This is a small enough subset of the format that
 * hand-rolling it beats adding a dependency for it, while still producing an archive any real
 * `tar` binary can list/extract (`tar tzvf backup.tar.gz`) for a human to inspect — useful for
 * "how do I get my data out of this" peace of mind (see docs/OPERATIONS.md).
 */

import { gunzipSync, gzipSync } from "node:zlib";

export interface TarEntry {
  /** Forward-slash-separated relative path, e.g. "assets/1k7f3q9xz2hav4.png". Max 100 bytes. */
  path: string;
  data: Buffer;
}

const BLOCK_SIZE = 512;
const MAGIC = "ustar\0";

function writeAscii(buf: Buffer, offset: number, len: number, s: string): void {
  if (Buffer.byteLength(s, "utf8") > len) {
    throw new Error(`tar field overflow: "${s}" exceeds ${len} bytes`);
  }
  buf.write(s, offset, len, "utf8");
}

/** Zero-padded octal, NUL-terminated, occupying exactly `len` bytes (the last of which is the
 * NUL) — the standard ustar convention for mode/uid/gid/size/mtime. */
function writeOctalField(buf: Buffer, offset: number, len: number, value: number): void {
  const digits = Math.max(0, value)
    .toString(8)
    .padStart(len - 1, "0");
  if (digits.length > len - 1) throw new Error(`tar numeric field overflow: ${value}`);
  buf.write(digits, offset, len - 1, "ascii");
  buf[offset + len - 1] = 0;
}

function parseOctalField(buf: Buffer, offset: number, len: number): number {
  const raw = buf.toString("ascii", offset, offset + len).replace(/[\0 ]+$/, "");
  if (raw.length === 0) return 0;
  return Number.parseInt(raw, 8);
}

function header(path: string, size: number, mtimeSec: number): Buffer {
  const pathBytes = Buffer.byteLength(path, "utf8");
  if (pathBytes > 100) throw new Error(`tar entry path too long (max 100 bytes): ${path}`);
  const buf = Buffer.alloc(BLOCK_SIZE);

  writeAscii(buf, 0, 100, path); // name
  writeOctalField(buf, 100, 8, 0o644); // mode
  writeOctalField(buf, 108, 8, 0); // uid
  writeOctalField(buf, 116, 8, 0); // gid
  writeOctalField(buf, 124, 12, size); // size
  writeOctalField(buf, 136, 12, mtimeSec); // mtime
  buf.fill(0x20, 148, 156); // chksum: 8 spaces while computing the sum below
  buf[156] = "0".charCodeAt(0); // typeflag: '0' = regular file
  writeAscii(buf, 257, 6, MAGIC); // magic "ustar\0"
  buf[263] = 0x30; // version[0] = '0'
  buf[264] = 0x30; // version[1] = '0'  ("00", not NUL-terminated)

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i] as number;
  // POSIX chksum: 6 octal digits + NUL + space, unlike every other numeric field.
  const digits = sum.toString(8).padStart(6, "0");
  buf.write(digits, 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;

  return buf;
}

function padded(size: number): number {
  const rem = size % BLOCK_SIZE;
  return rem === 0 ? size : size + (BLOCK_SIZE - rem);
}

/** Build a gzip-compressed ustar archive from `entries`, in order. */
export function createTarGz(entries: readonly TarEntry[]): Buffer {
  const mtimeSec = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry.path, entry.data.length, mtimeSec));
    parts.push(entry.data);
    const pad = padded(entry.data.length) - entry.data.length;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2)); // two zero blocks mark end-of-archive
  return gzipSync(Buffer.concat(parts));
}

/** Parse a gzip-compressed ustar archive back into its entries, in archive order. */
export function readTarGz(archive: Buffer): TarEntry[] {
  const buf = gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= buf.length) {
    const block = buf.subarray(offset, offset + BLOCK_SIZE);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    const name = block.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (name.length === 0) break;
    const size = parseOctalField(block, 124, 12);
    const dataStart = offset + BLOCK_SIZE;
    const data = Buffer.from(buf.subarray(dataStart, dataStart + size));
    entries.push({ path: name, data });
    offset = dataStart + padded(size);
  }
  return entries;
}
