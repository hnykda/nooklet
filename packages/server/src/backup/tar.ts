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
 *
 * Two implementations of the same byte format:
 *   - `writeTarGzFile` / `readTarGzFile` stream: memory is O(chunk), independent of graph size.
 *     These are what backup/restore use. A 280 MB graph OOMKilled a 512 MiB backup job when this
 *     module only had the in-memory pair (docs/progress/streaming-backup.md).
 *   - `createTarGz` / `readTarGz` work on whole Buffers. `readTarGz` is the reader every build up
 *     to c9d993b restored with, so tests use it to prove a streamed archive still restores on an
 *     older nooklet. Not for production paths: memory is several times the archive.
 *
 * Both produce ONE gzip member holding a plain ustar stream, so either reader reads either
 * writer's output (and so does `tar xzf`).
 */

import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { constants, createGunzip, createGzip, type Gzip, gunzipSync, gzipSync } from "node:zlib";

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

/** A file to stream into an archive. */
export interface TarFileSource {
  /** Archive path, forward-slash separated, max 100 bytes. */
  path: string;
  /** File on disk to read it from. */
  file: string;
  /** Size recorded in the header. A tar header precedes its data, so a file that grew or shrank
   * between the stat and the read would corrupt every entry after it: checked, not trusted. */
  size: number;
  /** zlib level for this entry's bytes. Default 6. */
  level?: number;
}

export interface TarBufferSource {
  path: string;
  data: Buffer;
  level?: number;
}

/** zlib's own default, spelled out: `Z_DEFAULT_COMPRESSION` is -1, which never compares equal to
 * an explicit 6 and would trigger needless level switches. */
export const DEFAULT_GZIP_LEVEL = 6;

/**
 * Backpressure for writing into `gz` while something else drains it: `write` waits for `drain`
 * when gzip's buffer is full, and rejects instead if the drain side has failed. One listener per
 * wait, removed when it settles. (Racing each wait against the drain promise instead would add a
 * reaction to that never-settling promise per wait: tens of thousands for a large graph, an
 * O(graph) heap leak in a path whose whole point is O(chunk).)
 */
function backpressure(gz: Gzip, drained: Promise<void>) {
  let failure: unknown;
  let rejectWait: ((err: unknown) => void) | undefined;
  drained.catch((err) => {
    failure = err ?? new Error("archive write failed");
    rejectWait?.(failure);
  });
  return async function write(chunk: Buffer): Promise<void> {
    if (failure) throw failure;
    if (gz.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        rejectWait = undefined;
        resolve();
      };
      gz.once("drain", onDrain);
      rejectWait = (err) => {
        gz.off("drain", onDrain);
        rejectWait = undefined;
        reject(err);
      };
    });
  };
}

/** Change the deflate level between entries. `params` queues a sync flush and applies the new
 * level in that flush's callback. Waiting for it before the next write means nothing is in flight
 * when the level changes; with writes queued behind the flush, Node would start the next threadpool
 * deflate before running the callback. */
function setLevel(gz: Gzip, level: number): Promise<void> {
  // `params` exists on every zlib stream at runtime; @types/node only declares it on Deflate etc.
  const z = gz as Gzip & { params(l: number, s: number, cb: () => void): void };
  return new Promise((res) => z.params(level, constants.Z_DEFAULT_STRATEGY, () => res()));
}

/**
 * Stream a gzip-compressed ustar archive into `out` (an open file handle: the caller owns the temp
 * name, fsync and rename). Each file goes `createReadStream` -> one shared gzip stream -> `out`,
 * chunk by chunk, pausing on `drain` whenever the gzip buffer is full, so memory stays O(chunk)
 * whatever the graph's size. Returns the compressed byte count.
 */
export async function writeTarGzFile(
  out: FileHandle,
  entries: Iterable<TarFileSource | TarBufferSource>,
): Promise<number> {
  const mtimeSec = Math.floor(Date.now() / 1000);
  let level = DEFAULT_GZIP_LEVEL;
  const gz = createGzip({ level, chunkSize: 64 * 1024 });
  let bytesWritten = 0;
  // Drain gzip's output into the file handle. Pulling with for-await is the backpressure: while a
  // write is pending, gzip's readable side fills, `gz.write` returns false, and the producer
  // below waits for `drain`. (An fs.WriteStream over a caller-owned FileHandle with
  // `autoClose: false` never emits 'close', so `pipeline` into one never settles.)
  const done = (async () => {
    for await (const chunk of gz) {
      const buf = chunk as Buffer;
      let off = 0;
      while (off < buf.length) {
        off += (await out.write(buf, off, buf.length - off)).bytesWritten;
      }
      bytesWritten += buf.length;
    }
  })();
  // Awaited at the end; until then a failure surfaces through `write`, which rejects with it.
  // Without this, an early failure would also be reported as an unhandled rejection.
  done.catch(() => {});
  const write = backpressure(gz, done);

  try {
    for (const entry of entries) {
      const want = entry.level ?? DEFAULT_GZIP_LEVEL;
      if (want !== level) {
        await setLevel(gz, want);
        level = want;
      }
      const size = "data" in entry ? entry.data.length : entry.size;
      await write(header(entry.path, size, mtimeSec));
      if ("data" in entry) {
        if (size > 0) await write(entry.data);
      } else {
        let seen = 0;
        for await (const chunk of createReadStream(entry.file, { highWaterMark: 64 * 1024 })) {
          const buf = chunk as Buffer;
          seen += buf.length;
          if (seen > size) throw new Error(`${entry.path} grew while it was being archived`);
          await write(buf);
        }
        if (seen !== size) throw new Error(`${entry.path} shrank while it was being archived`);
      }
      const pad = padded(size) - size;
      if (pad > 0) await write(Buffer.alloc(pad));
    }
    await write(Buffer.alloc(BLOCK_SIZE * 2)); // end-of-archive
    gz.end();
    await done;
  } catch (err) {
    gz.destroy();
    throw err;
  }
  return bytesWritten;
}

export interface TarEntryHeader {
  path: string;
  size: number;
  /** ustar typeflag: "0" or "\0" regular file, "5" directory, "x"/"g" pax headers, ... */
  type: string;
}

/** Where `readTarGzFile` sends one entry's bytes. */
export interface TarEntrySink {
  write(chunk: Buffer): Promise<void>;
  end(): Promise<void>;
}

function checksumOk(block: Buffer): boolean {
  const stored = parseOctalField(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  return sum === stored;
}

function cString(buf: Buffer, start: number, end: number): string {
  const nul = buf.indexOf(0, start);
  return buf.toString("utf8", start, nul === -1 || nul > end ? end : nul);
}

/**
 * Stream-parse a gzip-compressed ustar archive: `createReadStream` -> `createGunzip` -> a small
 * state machine that hands each entry's bytes to the sink `onEntry` returns (`null` skips the
 * entry) as they arrive. Only a partial 512-byte header is ever held; the `for await` pull means a
 * slow sink pauses the gunzip and the file read. Rejects on a bad header checksum, a corrupt or
 * truncated gzip stream, or a missing end-of-archive marker — cases where the in-memory
 * `readTarGz` silently returned the entries it had parsed so far.
 */
export async function readTarGzFile(
  archivePath: string,
  onEntry: (h: TarEntryHeader) => Promise<TarEntrySink | null>,
): Promise<void> {
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  const source = createReadStream(archivePath, { highWaterMark: 64 * 1024 });
  source.on("error", (err) => gunzip.destroy(err));
  source.pipe(gunzip);

  const hdr = Buffer.alloc(BLOCK_SIZE);
  let hdrFill = 0;
  let state: "header" | "body" | "pad" | "end" = "header";
  let remaining = 0;
  let padRemaining = 0;
  let sink: TarEntrySink | null = null;

  try {
    for await (const raw of gunzip) {
      let chunk = raw as Buffer;
      while (chunk.length > 0 && state !== "end") {
        if (state === "header") {
          const take = Math.min(BLOCK_SIZE - hdrFill, chunk.length);
          chunk.copy(hdr, hdrFill, 0, take);
          hdrFill += take;
          chunk = chunk.subarray(take);
          if (hdrFill < BLOCK_SIZE) continue;
          hdrFill = 0;
          if (hdr.every((b) => b === 0)) {
            state = "end";
            break;
          }
          if (!checksumOk(hdr)) throw new Error("corrupt archive: tar header checksum mismatch");
          const name = cString(hdr, 0, 100);
          // ustar splits paths over 100 bytes into prefix + name; this module never writes one,
          // but a `tar czf` made by hand might.
          const prefix = hdr.toString("ascii", 257, 262) === "ustar" ? cString(hdr, 345, 500) : "";
          const size = parseOctalField(hdr, 124, 12);
          const type = String.fromCharCode(hdr[156] as number);
          sink = await onEntry({ path: prefix ? `${prefix}/${name}` : name, size, type });
          remaining = size;
          padRemaining = padded(size) - size;
          state = "body";
        }
        if (state === "body") {
          if (remaining > 0 && chunk.length > 0) {
            const take = Math.min(remaining, chunk.length);
            if (sink) await sink.write(chunk.subarray(0, take));
            remaining -= take;
            chunk = chunk.subarray(take);
          }
          if (remaining > 0) continue;
          if (sink) await sink.end();
          sink = null;
          state = "pad";
        }
        if (state === "pad") {
          const take = Math.min(padRemaining, chunk.length);
          padRemaining -= take;
          chunk = chunk.subarray(take);
          if (padRemaining === 0) state = "header";
        }
      }
      // No break at the end-of-archive marker: the rest of the stream (zero padding) is still
      // read, because gunzip only checks the gzip trailer's CRC-32 and length once it reaches
      // them. That check is what proves every extracted byte is the byte that was archived.
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (state !== "end") throw new Error("truncated archive: no end-of-archive marker");
}
