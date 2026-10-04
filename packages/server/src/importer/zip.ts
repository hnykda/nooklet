/// <reference path="./yauzl.d.ts" />
// (Referenced, not left to `include`: the web package typechecks server sources it imports.)

/**
 * Unpacks an uploaded .zip of a Logseq graph into a directory the importer can read (ADR 031).
 *
 * The archive comes from a client, so nothing in it is trusted. What this file guarantees:
 *
 * - **No path traversal (zip-slip).** An archive with an absolute or `..` entry name is refused
 *   outright (`checkedEntryName`). Beyond that, no entry name is ever used as a path: an output path is built from one
 *   of four fixed directory names and a single validated file-name component, then checked to be
 *   inside the destination.
 * - **No symlinks.** An entry whose unix mode says "symlink" is skipped with a warning; every file
 *   is written as a regular file with `wx` (never through an existing path).
 * - **Bounded size.** Entry count, total declared unpacked size and the compression ratio of each
 *   entry are checked against the central directory before anything is written, and inflation is
 *   capped at each entry's declared size (`readEntryData`). A decompression bomb stops there.
 * - **Only what the importer reads.** `pages/*.md`, `journals/*.md`, `assets/*` and
 *   `logseq/config.edn`; `logseq/bak/`, `.recycle/`, `.git/` and the rest are never unpacked.
 */

import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { findLogseqRoot, LogseqArchiveError, logseqArchiveTarget } from "@nooklet/core";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export interface ZipLimits {
  /** Most entries the central directory may list (files and folders together). */
  maxEntries: number;
  /** Most bytes the selected entries may unpack to, in total. */
  maxUnpackedBytes: number;
  /** Highest uncompressed/compressed ratio for an entry over 1 MiB. Real markdown is ~3-10x,
   * images ~1x; a bomb is thousands. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 200_000,
  maxUnpackedBytes: 4 * 1024 * 1024 * 1024,
  maxRatio: 200,
};

export class ZipRejectedError extends Error {}

export interface ExtractResult {
  /** The prefix inside the archive the graph lives under (`""` or e.g. `"my-graph/"`). */
  root: string;
  files: number;
  bytes: number;
  warnings: string[];
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((ok, fail) => {
    yauzl.open(
      path,
      // `decodeStrings: false`: names are decoded and checked here (`decodeEntryName`,
      // `checkedEntryName`), because yauzl's decoding garbles the UTF-8 names macOS writes.
      // yauzl only lists entries; their bytes are read by `readEntryData`, which also enforces
      // the declared sizes (yauzl's own streams stall on this Node; see there).
      { lazyEntries: true, autoClose: false, validateEntrySizes: false, decodeStrings: false },
      (err, zip) => {
        if (err || !zip) fail(new ZipRejectedError(`not a readable zip file (${err?.message})`));
        else ok(zip);
      },
    );
  });
}

/** Code page 437, bytes 0x80-0xFF: what the zip spec says a name without the UTF-8 flag is. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * An entry's name as text. The UTF-8 flag (bit 11) is what the spec says to look for, but macOS's
 * `zip` and Finder's Compress both write UTF-8 names WITHOUT it — yauzl then read them as CP437
 * and `Plánování.md` became `Pl├íno…` (found by the phone-width e2e). So: flagged or not, a name
 * that is valid UTF-8 is UTF-8; only one that is not falls back to CP437.
 */
export function decodeEntryName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString("utf8");
  try {
    return utf8.decode(raw);
  } catch {
    let out = "";
    for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    return out;
  }
}

/**
 * Refuses the names yauzl's own `validateFileName` refuses (it only runs with `decodeStrings`,
 * which is off so names can be decoded as above): absolute paths, drive letters, `..` segments.
 * Backslashes are separators, as Windows tools write them.
 */
export function checkedEntryName(name: string): string {
  const n = name.replace(/\\/g, "/");
  if (
    n.startsWith("/") ||
    /^[a-zA-Z]:/.test(n) ||
    n.split("/").includes("..") ||
    n.includes("\0")
  ) {
    throw new ZipRejectedError(`this zip is unsafe: it names a file outside itself (${name})`);
  }
  return n;
}

interface NamedEntry {
  entry: Entry;
  name: string;
}

function readEntries(zip: ZipFile, maxEntries: number): Promise<NamedEntry[]> {
  if (zip.entryCount > maxEntries) {
    return Promise.reject(
      new ZipRejectedError(`this zip lists ${zip.entryCount} entries; the limit is ${maxEntries}`),
    );
  }
  return new Promise((ok, fail) => {
    const entries: NamedEntry[] = [];
    zip.on("entry", (entry: Entry) => {
      try {
        const raw = entry.fileName;
        const text =
          typeof raw === "string" ? raw : decodeEntryName(raw, entry.generalPurposeBitFlag);
        entries.push({ entry, name: checkedEntryName(text) });
      } catch (err) {
        fail(err);
        return;
      }
      zip.readEntry();
    });
    zip.on("end", () => ok(entries));
    zip.on("error", (err: Error) =>
      fail(new ZipRejectedError(`this zip is damaged or unsafe (${err.message})`)),
    );
    zip.readEntry();
  });
}

/**
 * One entry's bytes, read straight from the archive and inflated in one call.
 *
 * Not yauzl's `openReadStream`: on this Node, yauzl 2.10's file reader (fd-slicer) stops emitting
 * part-way through an entry larger than ~768 KB, with no error and no end — a real-shaped graph's
 * first big image hung the import (`tools/probes/zip-stall.mjs`). yauzl still parses the central
 * directory, which works and is the part worth having a library for. Reading a local header and a
 * known number of bytes is not.
 *
 * `inflateRawSync`'s `maxOutputLength` is the bomb guard here: an entry may not inflate past the
 * size it declared, and the declared sizes were already checked against the limits.
 */
function readEntryData(fd: number, entry: Entry, name: string): Buffer {
  const header = Buffer.alloc(30);
  readSync(fd, header, 0, 30, entry.relativeOffsetOfLocalHeader);
  if (header.readUInt32LE(0) !== 0x04034b50) {
    throw new ZipRejectedError(`${name}: this zip is damaged (no local header)`);
  }
  const start =
    entry.relativeOffsetOfLocalHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const packed = Buffer.alloc(entry.compressedSize);
  let got = 0;
  while (got < packed.length) {
    const n = readSync(fd, packed, got, packed.length - got, start + got);
    if (n === 0) throw new ZipRejectedError(`${name}: this zip is truncated`);
    got += n;
  }
  let data: Buffer;
  if (entry.compressionMethod === 0) {
    data = packed;
  } else if (entry.compressionMethod === 8) {
    try {
      data = inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch (err) {
      throw new ZipRejectedError(
        `${name}: unpacks to more than it declared, or is damaged (${(err as Error).message})`,
      );
    }
  } else {
    throw new UnsupportedEntry(`${name}: compressed with a method this importer cannot read`);
  }
  if (data.length !== entry.uncompressedSize) {
    throw new ZipRejectedError(`${name}: unpacked to a different size than it declared`);
  }
  return data;
}

class UnsupportedEntry extends Error {}

export interface ExtractOptions {
  limits?: Partial<ZipLimits>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Unpacks the Logseq graph in `zipPath` into `destDir` (created; must not hold the files yet). */
export async function extractLogseqZip(
  zipPath: string,
  destDir: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...opts.limits };
  const zip = await openZip(zipPath);
  const fd = openSync(zipPath, "r");
  try {
    const entries = await readEntries(zip, limits.maxEntries);
    let root: string;
    try {
      root = findLogseqRoot(entries.map((e) => e.name));
    } catch (err) {
      if (err instanceof LogseqArchiveError) throw new ZipRejectedError(err.message);
      throw err;
    }
    const warnings: string[] = [];

    // Everything is checked against the central directory before a byte is written.
    const selected: Array<{ entry: Entry; name: string; target: string }> = [];
    let declared = 0;
    for (const { entry, name } of entries) {
      const target = logseqArchiveTarget(name, root);
      if (target === null) continue;
      const shown = name.slice(root.length);
      if (isSymlink(entry)) {
        warnings.push(`${shown}: a symbolic link, not imported`);
        continue;
      }
      if (entry.isEncrypted()) {
        warnings.push(`${shown}: encrypted, not imported`);
        continue;
      }
      // Not for a DB-version graph's database: SQLite's free pages are runs of zeros, and a big
      // one can legitimately pack past any ratio a markdown file would. The total limit and the
      // declared-size cap on inflation still apply to it.
      if (
        !target.startsWith("db.sqlite") &&
        entry.uncompressedSize > 1024 * 1024 &&
        entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.maxRatio
      ) {
        throw new ZipRejectedError(
          `${shown} would unpack ${Math.round(entry.uncompressedSize / Math.max(entry.compressedSize, 1))}x its packed size; refusing a possible zip bomb`,
        );
      }
      declared += entry.uncompressedSize;
      if (declared > limits.maxUnpackedBytes) {
        throw new ZipRejectedError(
          `this graph unpacks to more than ${Math.round(limits.maxUnpackedBytes / 1024 / 1024)} MB, the limit`,
        );
      }
      selected.push({ entry, name, target });
    }

    const dest = resolve(destDir);
    mkdirSync(dest, { recursive: true });
    let written = 0;
    let files = 0;
    const seen = new Set<string>();
    for (const { entry, name, target } of selected) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("cancelled");
      const out = resolve(dest, target);
      // Belt and braces: `logseqArchiveTarget` only builds fixed directories + one component.
      if (!out.startsWith(dest + sep)) {
        throw new ZipRejectedError(`${name}: resolves outside the import directory`);
      }
      // Case-insensitive disks (macOS, Windows) would make `A.md` and `a.md` one file.
      const key = out.normalize("NFC").toLowerCase();
      if (seen.has(key)) {
        warnings.push(`${name.slice(root.length)}: duplicate file name, skipped`);
        continue;
      }
      seen.add(key);
      let data: Buffer;
      try {
        data = readEntryData(fd, entry, name);
      } catch (err) {
        if (!(err instanceof UnsupportedEntry)) throw err;
        warnings.push(err.message);
        continue;
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, data, { flag: "wx" });
      written += data.length;
      files++;
      opts.onProgress?.(files, selected.length);
      // Reads and inflation are synchronous; let a status poll in between files.
      if (files % 20 === 0) await new Promise<void>((r) => setImmediate(r));
    }
    return { root, files, bytes: written, warnings };
  } finally {
    zip.close();
    closeSync(fd);
  }
}
