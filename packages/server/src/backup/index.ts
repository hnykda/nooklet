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
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { SCHEMA_VERSION } from "../schema.js";
import { createTarGz, readTarGz } from "./tar.js";

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
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  }
  out.sort();
  return out;
}

/**
 * Take a consistent backup of `opts.dataDir`'s database and `assets/` into a single `.tar.gz`
 * archive at `opts.outPath` (or the default timestamped path under `<dataDir>/backups/`). Safe to
 * call against a live, in-use database (see file header).
 */
export function createBackup(driver: SqlDriver, opts: CreateBackupOptions): BackupResult {
  const schemaVersion =
    driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;

  const tmpDbPath = join(tmpdir(), `nooklet-backup-src-${randomBytes(8).toString("hex")}.sqlite`);
  try {
    driver.run("VACUUM INTO ?", [tmpDbPath]);
    const dbBytes = readFileSync(tmpDbPath);

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion,
      createdAt: Date.now(),
      sourceDataDir: opts.dataDir,
    };

    const assetsDir = join(opts.dataDir, "assets");
    const assetRelPaths = walkFiles(assetsDir);

    const entries = [
      { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { path: "graph.sqlite", data: dbBytes },
      ...assetRelPaths.map((rel) => ({
        path: `assets/${rel}`,
        data: readFileSync(join(assetsDir, rel)),
      })),
    ];

    const archive = createTarGz(entries);
    const outPath = opts.outPath ?? defaultBackupPath(opts.dataDir);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, archive);

    return { path: outPath, manifest, fileCount: entries.length, archiveBytes: archive.length };
  } finally {
    rmSync(tmpDbPath, { force: true });
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
  return walkFiles(join(dataDir, "assets")).length > 0;
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

/**
 * Restore `archivePath` (produced by `createBackup`) into `opts.dataDir`. Refuses to overwrite an
 * existing database/assets unless `opts.force`, and refuses an archive whose schema version is
 * newer than this build's `SCHEMA_VERSION` (an older archive is fine — `openDbWithStatus`'s normal
 * migration path brings it forward on next open).
 */
export function restoreBackup(archivePath: string, opts: RestoreOptions): RestoreResult {
  const archive = readFileSync(archivePath);
  const entries = readTarGz(archive);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  if (!manifestEntry) {
    throw new Error(`"${archivePath}" is not a nooklet backup archive (no manifest.json inside)`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8")) as BackupManifest;
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

  if (!opts.force && hasExistingData(opts.dataDir)) {
    throw new Error(
      `refusing to restore into "${opts.dataDir}": it already has a database and/or assets ` +
        `(pass --force to overwrite)`,
    );
  }

  mkdirSync(opts.dataDir, { recursive: true });
  // A WAL and its index left by the database being replaced (a server killed hard never
  // checkpoints) belong to THAT file. SQLite does not check that a `-wal` matches the database
  // beside it, so the next open replays the old frames onto the restored file: "database disk
  // image is malformed" (tools/probes/restore-stale-wal.mjs). The archive's database is a
  // self-contained VACUUM INTO snapshot; nothing in the old WAL is wanted.
  if (entries.some((e) => e.path === "graph.sqlite")) {
    const db = dbPath(opts.dataDir);
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
  }
  let filesRestored = 0;
  for (const entry of entries) {
    if (entry.path === "manifest.json") continue;
    const dest = safeJoin(opts.dataDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
    filesRestored++;
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
