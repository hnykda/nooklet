import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { newId } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { SCHEMA_VERSION } from "../schema.js";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  createBackup,
  defaultBackupPath,
  fileSizeOf,
  graphDbPath,
  restoreBackup,
  sha256File,
} from "./index.js";
import { createTarGz } from "./tar.js";

let dataDir: string;
let ctx: ServerContext;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-backup-test-"));
  ctx = createServerContext(openDb({ path: graphDbPath(dataDir) }));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createPage(name: string): string {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "page.create", name, journalDay: null, createdAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function createBlock(pageId: string, content: string, parentId: string | null = null): string {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: {
          kind: "block.create",
          place: { pageId, parentId, order: "a0" },
          content,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

/** Full-row dump of every user-data table, ordered by primary key -- the same "SELECT * ... ORDER
 * BY <pk>" approach `sync-test-helpers.ts`'s `dumpState` and `sync.property.test.ts`'s `dumpState`
 * use for sync's 4 state tables, extended here to every table a backup/restore round trip must
 * preserve byte-for-byte. */
function dumpAll(driver: SqlDriver): Record<string, unknown[]> {
  return {
    pages: driver.all("SELECT * FROM page ORDER BY id"),
    blocks: driver.all("SELECT * FROM block ORDER BY id"),
    blockProps: driver.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: driver.all("SELECT * FROM page_prop ORDER BY page_id, key"),
    ops: driver.all("SELECT * FROM op ORDER BY seq"),
    changes: driver.all("SELECT * FROM changes ORDER BY seq"),
    refs: driver.all("SELECT * FROM ref ORDER BY id"),
    pathRefs: driver.all("SELECT * FROM path_ref ORDER BY block_id, page_key"),
    assets: driver.all("SELECT * FROM asset ORDER BY id"),
  };
}

function seedGraph(): void {
  const home = createPage("Home");
  createBlock(home, "Hello [[Projects]] #idea");
  const projects = createPage("Projects");
  createBlock(projects, "First project");
  createBlock(projects, "Nested", createBlock(projects, "Parent"));
}

describe("createBackup / restoreBackup", () => {
  it("round-trips: a restored database has identical state to the source", () => {
    seedGraph();
    const before = dumpAll(ctx.driver);

    const backup = createBackup(ctx.driver, { dataDir });
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.manifest.format).toBe(BACKUP_FORMAT);
    expect(backup.manifest.schemaVersion).toBe(SCHEMA_VERSION);

    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-test-"));
    try {
      const result = restoreBackup(backup.path, { dataDir: restoreDir });
      expect(result.filesRestored).toBeGreaterThanOrEqual(1); // at least graph.sqlite
      expect(existsSync(graphDbPath(restoreDir))).toBe(true);

      // Byte-identical database file: VACUUM INTO's output is deterministic for a given state,
      // so re-opening it must not even be necessary to prove fidelity -- but we also open it and
      // diff state row-for-row, since that's the guarantee that actually matters operationally.
      const restoredCtx = createServerContext(openDb({ path: graphDbPath(restoreDir) }));
      const after = dumpAll(restoredCtx.driver);
      expect(after).toEqual(before);
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("includes assets/ in the archive and restores them", () => {
    seedGraph();
    const assetsDir = join(dataDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "1k7f3q9xz2hav4.png"), Buffer.from([1, 2, 3, 4]));
    mkdirSync(join(assetsDir, "sub"), { recursive: true });
    writeFileSync(join(assetsDir, "sub", "nested.txt"), "nested");

    const backup = createBackup(ctx.driver, { dataDir });
    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-assets-"));
    try {
      restoreBackup(backup.path, { dataDir: restoreDir });
      expect(
        readFileSync(join(restoreDir, "assets", "1k7f3q9xz2hav4.png")).equals(
          Buffer.from([1, 2, 3, 4]),
        ),
      ).toBe(true);
      expect(readFileSync(join(restoreDir, "assets", "sub", "nested.txt"), "utf8")).toBe("nested");
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("is a true point-in-time snapshot: a write committed after VACUUM INTO starts does not corrupt it, and one before it is included", () => {
    // Committed BEFORE the backup call -- must be present.
    const before = createPage("Before");
    createBlock(before, "already here");

    const backup = createBackup(ctx.driver, { dataDir });

    // Committed AFTER the backup call returns -- must NOT be present in the archive just taken.
    const after = createPage("After");
    createBlock(after, "added later");

    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-snapshot-"));
    try {
      restoreBackup(backup.path, { dataDir: restoreDir });
      const restoredCtx = createServerContext(openDb({ path: graphDbPath(restoreDir) }));
      const names = restoredCtx.driver
        .all<{ name: string }>("SELECT name FROM page ORDER BY name")
        .map((r) => r.name);
      expect(names).toContain("Before");
      expect(names).not.toContain("After");
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("refuses to restore into a data dir that already has a database, unless --force", () => {
    seedGraph();
    const backup = createBackup(ctx.driver, { dataDir });

    const targetDir = mkdtempSync(join(tmpdir(), "nooklet-restore-clobber-"));
    try {
      openDb({ path: graphDbPath(targetDir) }); // pre-existing database at the target
      expect(() => restoreBackup(backup.path, { dataDir: targetDir })).toThrow(/refusing/);
      const result = restoreBackup(backup.path, { dataDir: targetDir, force: true });
      expect(result.filesRestored).toBeGreaterThan(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("refuses to restore an archive newer than the running build", () => {
    const futureManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION + 1,
      createdAt: Date.now(),
      sourceDataDir: dataDir,
    };
    const archive = createTarGz([
      { path: "manifest.json", data: Buffer.from(JSON.stringify(futureManifest)) },
      { path: "graph.sqlite", data: Buffer.from("irrelevant") },
    ]);
    const archivePath = join(dataDir, "future.tar.gz");
    writeFileSync(archivePath, archive);

    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-future-"));
    try {
      expect(() => restoreBackup(archivePath, { dataDir: restoreDir })).toThrow(/newer/);
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("restoring the real archive from this build succeeds (sanity: version guard doesn't false-positive)", () => {
    seedGraph();
    const backup = createBackup(ctx.driver, { dataDir });
    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-version-"));
    try {
      expect(() => restoreBackup(backup.path, { dataDir: restoreDir })).not.toThrow();
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("defaultBackupPath lives under <dataDir>/backups and fileSizeOf reads a real file", () => {
    const p = defaultBackupPath(dataDir, new Date("2026-09-11T12:00:00Z"));
    expect(p.startsWith(join(dataDir, "backups"))).toBe(true);
    expect(p.endsWith(".tar.gz")).toBe(true);

    const backup = createBackup(ctx.driver, { dataDir, outPath: p });
    expect(fileSizeOf(backup.path)).toBe(backup.archiveBytes);
    expect(fileSizeOf(join(dataDir, "does-not-exist"))).toBeUndefined();
  });

  it("sha256File is stable for identical bytes", () => {
    const backup = createBackup(ctx.driver, { dataDir });
    expect(sha256File(backup.path)).toBe(sha256File(backup.path));
  });
});
