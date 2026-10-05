/**
 * `nooklet backup` / `nooklet restore` (M6, PLAN.md §15 "backups/restore"): a single consistent
 * archive of the data directory (the SQLite database plus `assets/`), taken without stopping the
 * server.
 *
 * Consistency: `VACUUM INTO` (SQLite's own online-backup primitive) writes a fresh, fully
 * consistent snapshot of the live database to a temp file in one atomic step, safe to run from a
 * second connection while the live connection has writes/transactions in flight (verified against
 * this package's actual `node:sqlite` driver — see `backup.test.ts`'s
 * "is a true point-in-time snapshot" case, which commits a write on the live driver concurrently
 * and asserts it does not appear in the backup). This is the "simple, correct choice" the task
 * calls for over a manual file-copy (which could read a torn WAL) or `.backup()` (node:sqlite's
 * `DatabaseSync` does not expose SQLite's page-level online backup API at all — `VACUUM INTO` is
 * the one online-backup primitive reachable through this driver).
 *
 * Ordering with `assets/`: `asset.upload` (`../ops/asset-upload.ts`) always writes the file to
 * disk *before* inserting its `asset` row (rename is the last disk step, the INSERT comes after).
 * So taking the `VACUUM INTO` snapshot first and copying `assets/` second guarantees every asset
 * row present in the snapshot already has its file on disk by the time we read it — the reverse
 * order could observe an `asset` row with no file yet.
 *
 * Memory: both directions stream (`./tar.ts`), so peak memory is O(chunk), not O(graph). The
 * first version read the snapshot and every asset into Buffers and gzipped the concatenation; a
 * 280 MB graph OOMKilled a 512 MiB backup job (docs/progress/streaming-backup.md has the
 * before/after RSS).
 *
 * Crash safety: the archive is written to `<out>.partial-<random>` and renamed into place only
 * after it is complete and fsynced, so a killed backup never leaves a truncated archive under the
 * final name. Restore extracts into `<graphDir>/.restore-<random>/`, validates there, and only
 * then renames the pieces over the live ones; a bad or truncated archive leaves the graph as it
 * was.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { type FileHandle, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "@nooklet/core";
import { THUMBS_DIR } from "../assets/variants.js";
import { SCHEMA_VERSION } from "../schema.js";
import {
  DEFAULT_GZIP_LEVEL,
  readTarGzFile,
  type TarBufferSource,
  type TarEntrySink,
  type TarFileSource,
  writeTarGzFile,
} from "./tar.js";

export const BACKUP_FORMAT = "nooklet-backup";
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  createdAt: number;
  /** Informational only, never trusted on restore. */
  sourceDataDir: string;
}

export interface CreateBackupOptions {
  dataDir: string;
  /** Defaults to `<dataDir>/backups/nooklet-backup-<timestamp>.tar.gz`. */
  outPath?: string;
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
  fileCount: number;
  archiveBytes: number;
}

function dbPath(dataDir: string): string {
  return join(dataDir, "graph.sqlite");
}

export function defaultBackupPath(dataDir: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return join(dataDir, "backups", `nooklet-backup-${ts}.tar.gz`);
}

/** Every regular file under `dir`, as POSIX-style paths relative to `dir` (stable order). Empty
 * array if `dir` doesn't exist. */
function walkFiles(dir: string, skipTopDir?: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory() && cur === dir && entry.name === skipTopDir) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  }
  out.sort();
  return out;
}

/**
 * Formats that are already compressed. Deflating them again costs CPU for nothing: measured on
 * 50 MiB of random bytes (what a JPEG looks like to deflate), levels 1 and 6 both took ~760 ms and
 * saved 0 bytes; level 0 (stored) took 21 ms. The database is different — 169 MiB went to 63 MiB
 * at level 1 (1.3 s) and 60 MiB at level 6 (2.7 s) — so it, the manifest and any other asset keep
 * the default level 6: a few percent smaller nightly archives for about a second of CPU per 60 MB.
 */
const STORED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".zst",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
]);

export function gzipLevelFor(path: string): number {
  return STORED_EXTENSIONS.has(extname(path).toLowerCase()) ? 0 : DEFAULT_GZIP_LEVEL;
}

/** Best effort: makes a rename durable on Linux/macOS; some filesystems refuse to fsync a dir. */
async function fsyncDir(dir: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch {
    // Not fatal: the archive itself is fsynced; only the rename's durability is at stake.
  } finally {
    await fh?.close().catch(() => {});
  }
}

const SNAPSHOT_PREFIX = ".nooklet-snapshot-";
const PARTIAL_MARKER = ".partial-";
/** A backup still running keeps writing its partial archive, so its mtime stays fresh. Anything
 * this old is from a backup that was killed (OOMKilled, SIGKILL, node evicted): nothing removes
 * it otherwise, and on a nightly job it piles up a graph-sized file per failure. Hours, not
 * minutes, so a nightly CronJob and a pre-deploy backup overlapping never touch each other. */
export const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

function sweepStaleTemps(outDir: string, now: number): void {
  for (const name of readdirSync(outDir)) {
    if (!name.startsWith(SNAPSHOT_PREFIX) && !name.includes(PARTIAL_MARKER)) continue;
    const full = join(outDir, name);
    try {
      if (now - statSync(full).mtimeMs > STALE_TEMP_MS) rmSync(full, { force: true });
    } catch {
      // Raced with its owner finishing; nothing to do.
    }
  }
}

/**
 * Take a consistent backup of `opts.dataDir`'s database and `assets/` into a single `.tar.gz`
 * archive at `opts.outPath` (or the default timestamped path under `<dataDir>/backups/`). Safe to
 * call against a live, in-use database (see file header).
 */
export async function createBackup(
  driver: SqlDriver,
  opts: CreateBackupOptions,
): Promise<BackupResult> {
  const schemaVersion =
    driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;

  const outPath = opts.outPath ?? defaultBackupPath(opts.dataDir);
  const outDir = dirname(outPath);
  mkdirSync(outDir, { recursive: true });
  sweepStaleTemps(outDir, Date.now());
  const nonce = randomBytes(6).toString("hex");
  // The snapshot sits beside the archive, not in os.tmpdir(): in a container /tmp may be a
  // memory-backed emptyDir, where a 50 MB snapshot counts against the very memory limit this
  // module is trying to stay under.
  const snapshotPath = join(outDir, `${SNAPSHOT_PREFIX}${nonce}.sqlite`);
  const partialPath = `${outPath}${PARTIAL_MARKER}${nonce}`;
  let out: FileHandle | undefined;
  try {
    driver.run("VACUUM INTO ?", [snapshotPath]);

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion,
      createdAt: Date.now(),
      sourceDataDir: opts.dataDir,
    };

    const assetsDir = join(opts.dataDir, "assets");
    const entries: (TarFileSource | TarBufferSource)[] = [
      // First, always: restore validates the manifest before extracting anything big.
      { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { path: "graph.sqlite", file: snapshotPath, size: statSync(snapshotPath).size },
      // Not the resized copies (`assets/.thumbs/`, ADR 035): a cache, made again on demand.
      ...walkFiles(assetsDir, THUMBS_DIR).map((rel) => {
        const file = join(assetsDir, rel);
        return { path: `assets/${rel}`, file, size: statSync(file).size, level: gzipLevelFor(rel) };
      }),
    ];

    // `wx`: never truncate something that is already there.
    out = await open(partialPath, "wx");
    const archiveBytes = await writeTarGzFile(out, entries);
    await out.sync();
    await out.close();
    out = undefined;
    await rename(partialPath, outPath);
    await fsyncDir(outDir);

    return { path: outPath, manifest, fileCount: entries.length, archiveBytes };
  } catch (err) {
    await out?.close().catch(() => {});
    rmSync(partialPath, { force: true });
    throw err;
  } finally {
    rmSync(snapshotPath, { force: true });
  }
}

export interface RestoreOptions {
  dataDir: string;
  /** Overwrite an existing database/assets at `dataDir` even though data is already there. */
  force?: boolean;
}

export interface RestoreResult {
  dataDir: string;
  manifest: BackupManifest;
  filesRestored: number;
}

/** True if `dataDir` already looks like it holds a graph (a database file, or any asset). */
function hasExistingData(dataDir: string): boolean {
  if (existsSync(dbPath(dataDir))) return true;
  return walkFiles(join(dataDir, "assets"), THUMBS_DIR).length > 0;
}

/** Reject an archive-entry path that would escape `dataDir` once joined — defense in depth for a
 * backup archive from an untrusted source, even though every archive this module itself writes is
 * always safe. */
function safeJoin(dataDir: string, entryPath: string): string {
  const dest = resolve(dataDir, entryPath);
  const root = resolve(dataDir) + sep;
  if (dest !== resolve(dataDir) && !dest.startsWith(root)) {
    throw new Error(`refusing to restore unsafe archive entry path "${entryPath}"`);
  }
  return dest;
}

/** The manifest is tiny; anything bigger is not one of ours, and is not buffered. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const STAGING_PREFIX = ".restore-";

function parseManifest(archivePath: string, bytes: Buffer): BackupManifest {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as BackupManifest;
  } catch {
    throw new Error(`"${archivePath}"'s manifest.json is not valid JSON`);
  }
  if (manifest.format !== BACKUP_FORMAT || typeof manifest.schemaVersion !== "number") {
    throw new Error(`"${archivePath}" does not look like a nooklet backup archive`);
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `archive schema version ${manifest.schemaVersion} is newer than this build supports ` +
        `(${SCHEMA_VERSION}); upgrade nooklet before restoring this backup`,
    );
  }
  return manifest;
}

/** The extracted database must be a SQLite file no newer than this build. Runs against the staged
 * copy, so a wrong archive is caught before anything live is touched. Not `PRAGMA quick_check`:
 * the gzip CRC-32 that `readTarGzFile` verifies already proves the bytes are the ones archived,
 * and quick_check took 5 s on a 169 MiB database. */
function checkStagedDatabase(archivePath: string, file: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v > SCHEMA_VERSION) {
      throw new Error(`its schema version ${v} is newer than this build supports`);
    }
  } catch (err) {
    throw new Error(
      `"${archivePath}"'s graph.sqlite is not a usable database: ${(err as Error).message}`,
    );
  } finally {
    db?.close();
    // Opening may have created these; they must not be moved next to the live database.
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
}

/** A sink that writes one entry straight to its file. FileHandle.write resolves once the kernel
 * has the bytes, so the parser never runs ahead of the disk. */
async function fileSink(dest: string, onOpen: (fh: FileHandle) => void): Promise<TarEntrySink> {
  mkdirSync(dirname(dest), { recursive: true });
  const fh = await open(dest, "w");
  onOpen(fh);
  return {
    async write(chunk) {
      let off = 0;
      while (off < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
        off += bytesWritten;
      }
    },
    async end() {
      await fh.close();
    },
  };
}

/**
 * Restore `archivePath` (produced by `createBackup`) into `opts.dataDir`. Refuses to overwrite an
 * existing database/assets unless `opts.force`, and refuses an archive whose schema version is
 * newer than this build's `SCHEMA_VERSION` (an older archive is fine — `openDbWithStatus`'s normal
 * migration path brings it forward on next open).
 *
 * Streams the archive into a staging directory inside `opts.dataDir` (same filesystem, so the
 * final renames are atomic), checks the manifest, the expected files and the database there, and
 * only then swaps: `assets/` is replaced as a whole and `graph.sqlite` is renamed over the old one
 * last. The restored graph holds exactly the archive's assets, not a union with whatever was
 * there before.
 */
export async function restoreBackup(
  archivePath: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  if (!opts.force && hasExistingData(opts.dataDir)) {
    throw new Error(
      `refusing to restore into "${opts.dataDir}": it already has a database and/or assets ` +
        `(pass --force to overwrite)`,
    );
  }
  mkdirSync(opts.dataDir, { recursive: true });
  // A previous restore killed mid-extraction leaves its staging directory behind; it holds
  // nothing the live graph needs.
  for (const name of readdirSync(opts.dataDir)) {
    if (name.startsWith(STAGING_PREFIX)) {
      rmSync(join(opts.dataDir, name), { recursive: true, force: true });
    }
  }
  const staging = await mkdtemp(join(opts.dataDir, STAGING_PREFIX));

  let manifest: BackupManifest | undefined;
  let sawDatabase = false;
  let filesRestored = 0;
  let openFile: FileHandle | undefined;
  try {
    await readTarGzFile(archivePath, async (h) => {
      // Directories, links, pax headers: never written by createBackup, skipped if a hand-made
      // archive has them. A file's own path creates its parent directories.
      if (h.type !== "0" && h.type !== "\0" && h.type !== "7") return null;
      const path = h.path.replace(/^(\.\/)+/, "");
      if (path === "manifest.json") {
        if (h.size > MAX_MANIFEST_BYTES) {
          throw new Error(`"${archivePath}"'s manifest.json is implausibly large`);
        }
        const parts: Buffer[] = [];
        return {
          async write(chunk) {
            parts.push(Buffer.from(chunk));
          },
          async end() {
            // Validated as soon as it is read — it is the first entry — so a wrong or too-new
            // archive is refused before hundreds of MB are extracted.
            manifest = parseManifest(archivePath, Buffer.concat(parts));
          },
        };
      }
      if (path === "" || path.endsWith("/") || path.startsWith(STAGING_PREFIX)) return null;
      if (path === "graph.sqlite") sawDatabase = true;
      filesRestored++;
      return fileSink(safeJoin(staging, path), (fh) => {
        openFile = fh;
      });
    });
    if (!manifest) {
      throw new Error(`"${archivePath}" is not a nooklet backup archive (no manifest.json inside)`);
    }
    if (!sawDatabase) throw new Error(`"${archivePath}" has no graph.sqlite inside`);
    checkStagedDatabase(archivePath, join(staging, "graph.sqlite"));

    // Swap. A WAL and its index left by the database being replaced (a server killed hard never
    // checkpoints) belong to THAT file. SQLite does not check that a `-wal` matches the database
    // beside it, so the next open replays the old frames onto the restored file: "database disk
    // image is malformed" (tools/probes/restore-stale-wal.mjs). The archive's database is a
    // self-contained VACUUM INTO snapshot; nothing in the old WAL is wanted.
    const db = dbPath(opts.dataDir);
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    const trash = join(staging, ".replaced");
    mkdirSync(trash);
    const staged = readdirSync(staging).filter((n) => n !== ".replaced");
    // The archive is the whole truth about assets: an asset the backup did not have goes too.
    if (!staged.includes("assets") && existsSync(join(opts.dataDir, "assets"))) {
      await rename(join(opts.dataDir, "assets"), join(trash, "assets"));
    }
    // graph.sqlite last, so the database only appears once its assets are in place.
    staged.sort((a, b) => Number(a === "graph.sqlite") - Number(b === "graph.sqlite"));
    for (const name of staged) {
      const live = join(opts.dataDir, name);
      if (existsSync(live) && statSync(live).isDirectory()) {
        await rename(live, join(trash, name));
      }
      await rename(join(staging, name), live);
    }
    await fsyncDir(opts.dataDir);
  } finally {
    await openFile?.close().catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }

  return { dataDir: opts.dataDir, manifest, filesRestored };
}

/** File size on disk, or `undefined` if it doesn't exist (e.g. an in-memory-only test database
 * has no backing file for `nooklet gc` to measure "space reclaimed" against). */
export function fileSizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

export function graphDbPath(dataDir: string): string {
  return dbPath(dataDir);
}

/** SHA-256 of a file's bytes — used only by tests to assert round-trip identity of the raw
 * database file, since VACUUM INTO's output is byte-for-byte deterministic for a given state. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
