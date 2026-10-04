/**
 * Unpacks an uploaded .zip of a Logseq graph into a directory the importer can read (ADR 030).
 *
 * The archive comes from a client, so nothing in it is trusted. What this file guarantees:
 *
 * - **No path traversal (zip-slip).** yauzl refuses an archive with an absolute or `..` entry name
 *   outright. Beyond that, no entry name is ever used as a path: an output path is built from one
 *   of four fixed directory names and a single validated file-name component, then checked to be
 *   inside the destination.
 * - **No symlinks.** An entry whose unix mode says "symlink" is skipped with a warning; every file
 *   is written as a regular file with `wx` (never through an existing path).
 * - **Bounded size.** Entry count, total declared unpacked size and the compression ratio of each
 *   entry are checked against the central directory before anything is written, and the bytes
 *   actually inflated are counted while writing: an entry that inflates past its declared size is
 *   cut off at that size. A decompression bomb stops at the limit.
 * - **Only what the importer reads.** `pages/*.md`, `journals/*.md`, `assets/*` and
 *   `logseq/config.edn`; `logseq/bak/`, `.recycle/`, `.git/` and the rest are never unpacked.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
      // `decodeStrings` (default) is what makes yauzl reject absolute and `..` names; keep it.
      // `validateEntrySizes` OFF on purpose: with it on, an entry that inflates past its declared
      // size made yauzl 2.10's stream go silent (no data, no error, no end) and the import hung
      // forever. `copyEntry` enforces the declared size itself.
      { lazyEntries: true, autoClose: false, validateEntrySizes: false },
      (err, zip) => {
        if (err || !zip) fail(new ZipRejectedError(`not a readable zip file (${err?.message})`));
        else ok(zip);
      },
    );
  });
}

function readEntries(zip: ZipFile, maxEntries: number): Promise<Entry[]> {
  if (zip.entryCount > maxEntries) {
    return Promise.reject(
      new ZipRejectedError(`this zip lists ${zip.entryCount} entries; the limit is ${maxEntries}`),
    );
  }
  return new Promise((ok, fail) => {
    const entries: Entry[] = [];
    zip.on("entry", (entry: Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => ok(entries));
    zip.on("error", (err: Error) =>
      fail(new ZipRejectedError(`this zip is damaged or unsafe (${err.message})`)),
    );
    zip.readEntry();
  });
}

function openStream(zip: ZipFile, entry: Entry) {
  return new Promise<NodeJS.ReadableStream>((ok, fail) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) fail(err ?? new Error("no stream"));
      else ok(stream);
    });
  });
}

/**
 * Copies one entry's bytes to `out`, failing as soon as more than `limit` arrive.
 *
 * Not `stream.pipeline`: yauzl 2.x read streams do not emit `close` when destroyed after an error,
 * and `pipeline` waits for every stream to close, so a lying entry hung the import forever (the
 * "inflates past the size it declared" test caught it). This settles on the first error instead.
 */
const STALL_MS = 60_000;

function copyEntry(
  stream: NodeJS.ReadableStream & { destroy?: (err?: Error) => void },
  out: string,
  limit: number,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void,
): Promise<void> {
  const fd = openSync(out, "wx");
  return new Promise<void>((ok, fail) => {
    let seen = 0;
    let settled = false;
    // A stream that goes quiet must not hang the job (see `openZip` for the one that did).
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new ZipRejectedError("unpacking stalled; the zip may be damaged")),
        STALL_MS,
      );
    };
    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
      closeSync(fd);
      if (err) {
        stream.removeAllListeners("data");
        stream.on("error", () => {}); // late errors from a stream we have given up on
        stream.destroy?.();
        fail(err);
      } else ok();
    };
    const onAbort = () => settle(signal?.reason ?? new Error("cancelled"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    touch();
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      touch();
      seen += chunk.length;
      if (seen > limit) {
        settle(new ZipRejectedError("an entry unpacked to more than it declared"));
        return;
      }
      writeSync(fd, chunk);
      onBytes(chunk.length);
    });
    stream.on("error", (err: Error) =>
      settle(new ZipRejectedError(`this zip is damaged (${err.message})`)),
    );
    stream.on("end", () => settle());
  });
}

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
  try {
    const entries = await readEntries(zip, limits.maxEntries);
    let root: string;
    try {
      root = findLogseqRoot(entries.map((e) => e.fileName));
    } catch (err) {
      if (err instanceof LogseqArchiveError) throw new ZipRejectedError(err.message);
      throw err;
    }
    const warnings: string[] = [];

    // Everything is checked against the central directory before a byte is written.
    const selected: Array<{ entry: Entry; target: string }> = [];
    let declared = 0;
    for (const entry of entries) {
      const target = logseqArchiveTarget(entry.fileName, root);
      if (target === null) continue;
      const shown = entry.fileName.slice(root.length);
      if (isSymlink(entry)) {
        warnings.push(`${shown}: a symbolic link, not imported`);
        continue;
      }
      if (entry.isEncrypted()) {
        warnings.push(`${shown}: encrypted, not imported`);
        continue;
      }
      if (
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
      selected.push({ entry, target });
    }

    const dest = resolve(destDir);
    for (const dir of ["pages", "journals", "assets", "logseq"])
      mkdirSync(join(dest, dir), { recursive: true });
    let written = 0;
    let files = 0;
    const seen = new Set<string>();
    for (const { entry, target } of selected) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("cancelled");
      const out = resolve(dest, target);
      // Belt and braces: `logseqArchiveTarget` only builds `<fixed dir>/<one component>`.
      if (!out.startsWith(dest + sep)) {
        throw new ZipRejectedError(`${entry.fileName}: resolves outside the import directory`);
      }
      // Case-insensitive disks (macOS, Windows) would make `A.md` and `a.md` one file.
      const key = out.normalize("NFC").toLowerCase();
      if (seen.has(key)) {
        warnings.push(`${entry.fileName.slice(root.length)}: duplicate file name, skipped`);
        continue;
      }
      seen.add(key);
      const stream = await openStream(zip, entry);
      await copyEntry(stream, out, entry.uncompressedSize, opts.signal, (n) => {
        written += n;
      });
      files++;
      opts.onProgress?.(files, selected.length);
    }
    return { root, files, bytes: written, warnings };
  } finally {
    zip.close();
  }
}
