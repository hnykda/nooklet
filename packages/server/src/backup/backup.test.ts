import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "@nooklet/core";
import { newId } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { storeAssetBytes } from "../assets/store.js";
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
  STALE_TEMP_MS,
  sha256File,
} from "./index.js";
import { createTarGz, readTarGz, type TarEntry } from "./tar.js";

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
  it("round-trips: a restored database has identical state to the source", async () => {
    seedGraph();
    // An asset row too, so its URL key (B-737) is part of what must come back unchanged: a
    // restored graph whose keys changed would break every link handed out before.
    storeAssetBytes(ctx.driver, dataDir, {
      bytes: Buffer.from("a picture"),
      fileName: "p.png",
      mimeType: "image/png",
      origin: "user",
      actor: "test",
    });
    const before = dumpAll(ctx.driver);
    expect((before.assets?.[0] as { url_key: string }).url_key).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const backup = await createBackup(ctx.driver, { dataDir });
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.manifest.format).toBe(BACKUP_FORMAT);
    expect(backup.manifest.schemaVersion).toBe(SCHEMA_VERSION);

    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-test-"));
    try {
      const result = await restoreBackup(backup.path, { dataDir: restoreDir });
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

  it("includes assets/ in the archive and restores them", async () => {
    seedGraph();
    const assetsDir = join(dataDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "1k7f3q9xz2hav4.png"), Buffer.from([1, 2, 3, 4]));
    mkdirSync(join(assetsDir, "sub"), { recursive: true });
    writeFileSync(join(assetsDir, "sub", "nested.txt"), "nested");

    const backup = await createBackup(ctx.driver, { dataDir });
    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-assets-"));
    try {
      await restoreBackup(backup.path, { dataDir: restoreDir });
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

  it("is a true point-in-time snapshot: a write committed after VACUUM INTO starts does not corrupt it, and one before it is included", async () => {
    // Committed BEFORE the backup call -- must be present.
    const before = createPage("Before");
    createBlock(before, "already here");

    const backup = await createBackup(ctx.driver, { dataDir });

    // Committed AFTER the backup call returns -- must NOT be present in the archive just taken.
    const after = createPage("After");
    createBlock(after, "added later");

    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-snapshot-"));
    try {
      await restoreBackup(backup.path, { dataDir: restoreDir });
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

  it("refuses to restore into a data dir that already has a database, unless --force", async () => {
    seedGraph();
    const backup = await createBackup(ctx.driver, { dataDir });

    const targetDir = mkdtempSync(join(tmpdir(), "nooklet-restore-clobber-"));
    try {
      openDb({ path: graphDbPath(targetDir) }); // pre-existing database at the target
      await expect(restoreBackup(backup.path, { dataDir: targetDir })).rejects.toThrow(/refusing/);
      const result = await restoreBackup(backup.path, { dataDir: targetDir, force: true });
      expect(result.filesRestored).toBeGreaterThan(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("--force over a database whose writer died with an un-checkpointed WAL: the stale WAL is not replayed onto the restored file", async () => {
    seedGraph();
    const before = dumpAll(ctx.driver);
    const backup = await createBackup(ctx.driver, { dataDir });

    // The target's previous database, abandoned mid-WAL the way a killed server leaves it: a
    // second connection with checkpointing off, never closed. Its -wal/-shm stay on disk.
    const targetDir = mkdtempSync(join(tmpdir(), "nooklet-restore-stale-wal-"));
    try {
      const old = new DatabaseSync(graphDbPath(targetDir));
      old.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE junk(x)");
      const insert = old.prepare("INSERT INTO junk VALUES (?)");
      for (let i = 0; i < 200; i++) insert.run("x".repeat(500));
      // Copy the -wal aside while the connection holds it, then put it back after closing (a
      // clean close would checkpoint and delete it, which is exactly what a crash does not do).
      const wal = readFileSync(`${graphDbPath(targetDir)}-wal`);
      old.close();
      writeFileSync(`${graphDbPath(targetDir)}-wal`, wal);

      await restoreBackup(backup.path, { dataDir: targetDir, force: true });
      expect(existsSync(`${graphDbPath(targetDir)}-wal`)).toBe(false);
      const restored = createServerContext(openDb({ path: graphDbPath(targetDir) }));
      expect(dumpAll(restored.driver)).toEqual(before);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("refuses to restore an archive newer than the running build", async () => {
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
      await expect(restoreBackup(archivePath, { dataDir: restoreDir })).rejects.toThrow(/newer/);
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("restoring the real archive from this build succeeds (sanity: version guard doesn't false-positive)", async () => {
    seedGraph();
    const backup = await createBackup(ctx.driver, { dataDir });
    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-restore-version-"));
    try {
      await expect(restoreBackup(backup.path, { dataDir: restoreDir })).resolves.toBeDefined();
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("defaultBackupPath lives under <dataDir>/backups and fileSizeOf reads a real file", async () => {
    const p = defaultBackupPath(dataDir, new Date("2026-09-11T12:00:00Z"));
    expect(p.startsWith(join(dataDir, "backups"))).toBe(true);
    expect(p.endsWith(".tar.gz")).toBe(true);

    const backup = await createBackup(ctx.driver, { dataDir, outPath: p });
    expect(fileSizeOf(backup.path)).toBe(backup.archiveBytes);
    expect(fileSizeOf(join(dataDir, "does-not-exist"))).toBeUndefined();
  });

  it("sha256File is stable for identical bytes", async () => {
    const backup = await createBackup(ctx.driver, { dataDir });
    expect(sha256File(backup.path)).toBe(sha256File(backup.path));
  });
});

describe("streaming backup/restore: compatibility and failure modes", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "nooklet-backup-stream-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function seedAssets(): void {
    const assetsDir = join(dataDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "1k7f3q9xz2hav4.png"), Buffer.alloc(70_001, 7));
    writeFileSync(join(assetsDir, "2k7f3q9xz2hav4.txt"), "plain text asset");
  }

  it("restores an archive written by the old in-memory backup (fixture from c9d993b)", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "v1-c9d993b.tar.gz");
    const target = join(scratch, "g");
    const result = await restoreBackup(fixture, { dataDir: target });
    expect(result.filesRestored).toBe(3);
    const restored = createServerContext(openDb({ path: graphDbPath(target) }));
    const names = restored.driver
      .all<{ name: string }>("SELECT name FROM page WHERE journal_day IS NULL ORDER BY name")
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Fixture Home", "Fixture Other"]));
    expect(readFileSync(join(target, "assets", "fixtureasset02.txt"), "utf8")).toBe(
      "hello from an old archive\n",
    );
    expect(readFileSync(join(target, "assets", "fixtureasset01.png"))).toHaveLength(1500);
    // An archive from before B-737 opens at the current schema (migration 9 included). Its
    // asset files have no rows to key; `../db.test.ts` and `tools/probes/asset-keys/` cover rows.
    expect(restored.driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      SCHEMA_VERSION,
    );
  });

  it("a new archive restores with the old reader: readTarGz + write every entry, as c9d993b did", async () => {
    seedGraph();
    seedAssets();
    const before = dumpAll(ctx.driver);
    const backup = await createBackup(ctx.driver, { dataDir });

    const entries = readTarGz(readFileSync(backup.path));
    const manifest = JSON.parse(
      (entries.find((e) => e.path === "manifest.json") as TarEntry).data.toString("utf8"),
    );
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    const target = join(scratch, "old-reader");
    for (const e of entries) {
      if (e.path === "manifest.json") continue;
      mkdirSync(join(target, e.path, ".."), { recursive: true });
      writeFileSync(join(target, e.path), e.data);
    }
    const restored = createServerContext(openDb({ path: graphDbPath(target) }));
    expect(dumpAll(restored.driver)).toEqual(before);
    expect(readFileSync(join(target, "assets", "1k7f3q9xz2hav4.png"))).toEqual(
      Buffer.alloc(70_001, 7),
    );
  });

  it("a truncated archive is refused and --force leaves the existing graph exactly as it was", async () => {
    seedGraph();
    seedAssets();
    const backup = await createBackup(ctx.driver, { dataDir });
    const bytes = readFileSync(backup.path);
    const cut = join(scratch, "cut.tar.gz");
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.7)));

    // The target: a restore of the good archive, then fingerprinted.
    const target = join(scratch, "target");
    await restoreBackup(backup.path, { dataDir: target });
    const dbBefore = sha256File(graphDbPath(target));
    const assetsBefore = readdirSync(join(target, "assets")).sort();

    await expect(restoreBackup(cut, { dataDir: target, force: true })).rejects.toThrow();
    expect(sha256File(graphDbPath(target))).toBe(dbBefore);
    expect(readdirSync(join(target, "assets")).sort()).toEqual(assetsBefore);
    expect(readdirSync(target).filter((n) => n.startsWith(".restore-"))).toEqual([]);
  });

  it("an archive with a manifest but no graph.sqlite is refused", async () => {
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: 0,
      sourceDataDir: "/x",
    };
    const archivePath = join(scratch, "nodb.tar.gz");
    writeFileSync(
      archivePath,
      createTarGz([{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }]),
    );
    await expect(restoreBackup(archivePath, { dataDir: join(scratch, "t") })).rejects.toThrow(
      /no graph\.sqlite/,
    );
  });

  it("--force makes assets/ exactly the archive's: an asset added after the backup is gone", async () => {
    seedGraph();
    seedAssets();
    const backup = await createBackup(ctx.driver, { dataDir });
    writeFileSync(join(dataDir, "assets", "added-later.png"), "x");
    await restoreBackup(backup.path, { dataDir, force: true });
    expect(readdirSync(join(dataDir, "assets")).sort()).toEqual([
      "1k7f3q9xz2hav4.png",
      "2k7f3q9xz2hav4.txt",
    ]);
  });

  it("sweeps a killed backup's stale snapshot/partial files, but not a running backup's", async () => {
    const outDir = join(scratch, "backups");
    mkdirSync(outDir);
    const stale = [".nooklet-snapshot-aaaaaaaaaaaa.sqlite", "x.tar.gz.partial-aaaaaaaaaaaa"];
    const fresh = [".nooklet-snapshot-bbbbbbbbbbbb.sqlite", "x.tar.gz.partial-bbbbbbbbbbbb"];
    const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    for (const n of stale) {
      writeFileSync(join(outDir, n), "left by a SIGKILL");
      utimesSync(join(outDir, n), old, old);
    }
    for (const n of fresh) writeFileSync(join(outDir, n), "another backup, still running");
    await createBackup(ctx.driver, { dataDir, outPath: join(outDir, "new.tar.gz") });
    expect(readdirSync(outDir).sort()).toEqual([...fresh, "new.tar.gz"].sort());
  });

  it("a backup that fails part-way leaves nothing at the final path and no temp files", async () => {
    seedGraph();
    seedAssets();
    // An unreadable asset (sorted last) makes the stream fail mid-way, after the manifest, the
    // database and the first assets are already in the partial archive.
    const unreadable = join(dataDir, "assets", "3k7f3q9xz2hav4.png");
    writeFileSync(unreadable, "secret");
    chmodSync(unreadable, 0o000);
    const out = join(scratch, "backups", "b.tar.gz");
    try {
      await expect(createBackup(ctx.driver, { dataDir, outPath: out })).rejects.toThrow();
    } finally {
      chmodSync(unreadable, 0o644);
    }
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(join(scratch, "backups"))).toEqual([]);
  });
});
