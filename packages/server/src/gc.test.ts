import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { applyOps, initSchema, newId, rebuild } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { assetMarkdownPath, storeAssetBytes } from "./assets/store.js";
import { createToken } from "./auth/tokens.js";
import { graphDbPath, restoreBackup } from "./backup/index.js";
import { openDb } from "./db.js";
import { computeGcFloor, DEFAULT_ASSET_GRACE_DAYS, planAssetGc, planGc, runGc } from "./gc.js";
import { advanceAckedSeq, touchDeviceOnPush } from "./sync/device.js";

let dataDir: string;
let ctx: ServerContext;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-gc-test-"));
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

/** A small but real graph-shaped fixture: two pages, nested blocks, a page ref, a tag -- enough
 * for the op log to contain more than one kind of op (page.create, block.create) across more than
 * one entity, per the task's "real graph-shaped fixture" requirement. */
function seedGraph(): void {
  const home = createPage("Home");
  // `Projects` first: once `[[Projects]]` is written the server creates that page itself (ADR 024),
  // and this device's own `page.create` for the name would be refused.
  const projects = createPage("Projects");
  createBlock(home, "Hello [[Projects]] #idea");
  const parent = createBlock(projects, "Parent");
  createBlock(projects, "Child", parent);
  createBlock(projects, "Another top-level block");
}

function registerDevice(deviceId: string, ackedSeq: number, revoked = false): void {
  const created = createToken(ctx.driver, { label: deviceId, scope: "write", canSync: true });
  if (revoked) {
    ctx.driver.run("UPDATE token SET revoked_at = ? WHERE id = ?", [Date.now(), created.id]);
  }
  const identity = { tokenId: created.id, defaultName: deviceId };
  touchDeviceOnPush(ctx.driver, deviceId, identity);
  if (ackedSeq > 0) advanceAckedSeq(ctx.driver, deviceId, ackedSeq, identity);
}

function dumpState(driver: SqlDriver) {
  return {
    pages: driver.all("SELECT * FROM page ORDER BY id"),
    blocks: driver.all("SELECT * FROM block ORDER BY id"),
    blockProps: driver.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: driver.all("SELECT * FROM page_prop ORDER BY page_id, key"),
  };
}

function newScratchDriver(): SqlDriver {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  return driver;
}

describe("computeGcFloor", () => {
  it("refuses when no device has ever synced", async () => {
    seedGraph();
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBeNull();
    expect(floor.reason).toMatch(/no device/);
  });

  it("refuses when any live device has never acked (acked_seq = 0)", async () => {
    seedGraph();
    registerDevice("dev-a", 5);
    registerDevice("dev-b", 0); // pushed, never pulled
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBeNull();
    expect(floor.blockingDevices.map((d) => d.id)).toEqual(["dev-b"]);
  });

  it("ignores devices whose token has been revoked", async () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-live", tip);
    registerDevice("dev-gone", 0, /* revoked */ true);
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBe(tip);
    expect(floor.liveDeviceCount).toBe(1);
  });

  it("takes the minimum acked_seq across live devices, clamped to the current tip", async () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-behind", 2);
    registerDevice("dev-caught-up", tip);
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBe(2);
    expect(floor.currentTip).toBe(tip);
  });
});

describe("runGc", () => {
  it("dry-run reports counts and mutates nothing", async () => {
    seedGraph();
    registerDevice("dev-a", 2);
    const before = dumpState(ctx.driver);
    const opCountBefore = ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n ?? 0;

    const report = await runGc(ctx, { dataDir, dryRun: true });
    expect(report.refused).toBe(false);
    expect(report.floor).toBe(2);
    expect(report.dropCount).toBeGreaterThan(0);
    // Counted in SQL now (no whole-log load); must still agree with the materialised plan.
    const plan = planGc(ctx.driver);
    expect(report.dropCount).toBe(plan.drop.length);
    expect(report.retainCount).toBe(plan.retain.length);
    expect(report.backupPath).toBeUndefined();

    expect(dumpState(ctx.driver)).toEqual(before);
    expect(ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n).toBe(opCountBefore);
  });

  it("refuses a real run exactly like computeGcFloor, and touches nothing", async () => {
    seedGraph();
    const before = dumpState(ctx.driver);
    const report = await runGc(ctx, { dataDir });
    expect(report.refused).toBe(true);
    expect(report.backupPath).toBeUndefined();
    expect(dumpState(ctx.driver)).toEqual(before);
  });

  it("real run drops ops below the floor, takes a backup by default, and reclaims space", async () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-a", tip); // everyone fully caught up -> floor == tip

    const liveStateBefore = dumpState(ctx.driver);
    const report = await runGc(ctx, { dataDir });

    expect(report.refused).toBe(false);
    expect(report.floor).toBe(tip);
    expect(report.dropCount).toBeGreaterThan(0);
    expect(report.backupPath).toBeDefined();
    expect(existsSync(report.backupPath as string)).toBe(true);

    const minSeqAfter = ctx.driver.get<{ n: number | null }>("SELECT MIN(seq) AS n FROM op")?.n;
    expect(minSeqAfter === null || (minSeqAfter as number) >= tip).toBe(true);

    // GC must never touch the state tables (gc.ts's own docstring guarantee) -- state is
    // byte-identical before and after, only the op audit log shrank.
    expect(dumpState(ctx.driver)).toEqual(liveStateBefore);
  });

  it("--no-backup skips the automatic backup", async () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-a", tip);
    const report = await runGc(ctx, { dataDir, noBackup: true });
    expect(report.refused).toBe(false);
    expect(report.backupPath).toBeUndefined();
  });

  it("takes no backup when the floor drops nothing (seq is 1-indexed, so floor=1 always drops zero rows)", async () => {
    seedGraph();
    registerDevice("dev-a", 1);
    const report = await runGc(ctx, { dataDir });
    expect(report.refused).toBe(false);
    expect(report.dropCount).toBe(0);
    expect(report.backupPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Orphan assets (M7 item 10a) -- against a real temp data dir with real files under assets/.
// ---------------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** Store distinct bytes as an asset and, optionally, back-date it past the grace period the way
 * a long-forgotten upload would be. Returns the markdown path a block would embed. */
function storeAsset(name: string, ageDays = 0): { id: string; ext: string; path: string } {
  const stored = storeAssetBytes(ctx.driver, dataDir, {
    bytes: Buffer.from(`file:${name}:${Math.random()}`),
    fileName: name,
    mimeType: "text/plain",
    origin: "api",
    actor: "test",
  });
  if (ageDays > 0) {
    // Upload time is what the grace period is measured from; the audit row for the upload has
    // to move with it, or `planAssetGc` counts the row as a recent touch.
    const at = Date.now() - ageDays * DAY;
    ctx.driver.run("UPDATE asset SET created_at = ? WHERE id = ?", [at, stored.id]);
    ctx.driver.run(
      "UPDATE changes SET created_at = ? WHERE entity_type = 'asset' AND entity_id = ?",
      [at, stored.id],
    );
  }
  return { id: stored.id, ext: stored.ext, path: assetMarkdownPath(stored) };
}

function tombstoneBlock(id: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "block.delete", deletedAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

function tombstonePage(id: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "page.delete", deletedAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

function assetFiles(): string[] {
  return existsSync(join(dataDir, "assets")) ? readdirSync(join(dataDir, "assets")).sort() : [];
}

function liveAssetIds(): string[] {
  return ctx.driver
    .all<{ id: string }>("SELECT id FROM asset WHERE deleted_at IS NULL ORDER BY id")
    .map((r) => r.id);
}

describe("planAssetGc", () => {
  it("keeps an asset a live block references, however old", async () => {
    const page = createPage("Pics");
    const old = storeAsset("kept.png", 400);
    createBlock(page, `![kept](${old.path})`);
    const plan = planAssetGc(ctx.driver);
    expect(plan).toMatchObject({ total: 1, orphans: [], inGrace: 0, keptByTrashOnly: 0 });
    expect(plan.graceDays).toBe(DEFAULT_ASSET_GRACE_DAYS);
  });

  it("finds references in block and page properties too, not only block text", async () => {
    const page = createPage("Props");
    const inBlockProp = storeAsset("bp.png", 400);
    const inPageProp = storeAsset("pp.png", 400);
    const block = createBlock(page, "has a property");
    const h1 = ctx.hlc.next();
    const h2 = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: h1,
          hlc: h1,
          device: "aaaaaaaa",
          entity: block,
          payload: { kind: "block.prop", key: "cover", value: inBlockProp.path },
        },
        {
          id: h2,
          hlc: h2,
          device: "aaaaaaaa",
          entity: page,
          payload: { kind: "page.prop", key: "banner", value: `![](${inPageProp.path})` },
        },
      ],
      { origin: "user", actor: "test" },
    );
    expect(planAssetGc(ctx.driver).orphans).toEqual([]);
  });

  it("classifies an unreferenced asset by age: in grace when young, orphan when past it", async () => {
    const young = storeAsset("young.png");
    const old = storeAsset("old.png", DEFAULT_ASSET_GRACE_DAYS + 1);
    const plan = planAssetGc(ctx.driver);
    expect(plan.total).toBe(2);
    expect(plan.inGrace).toBe(1);
    expect(plan.orphans.map((o) => o.id)).toEqual([old.id]);
    expect(plan.orphans[0]).toMatchObject({ ext: "png", fileName: "old.png" });
    // The boundary is the grace setting, not a constant: with no grace the young one goes too.
    expect(
      planAssetGc(ctx.driver, { graceDays: 0 })
        .orphans.map((o) => o.id)
        .sort(),
    ).toEqual([young.id, old.id].sort());
  });

  it("a recent audit row for the asset extends its grace (the B-91 re-upload hook)", async () => {
    const old = storeAsset("touched.png", 400);
    ctx.driver.run(
      `INSERT INTO changes(graph_id, batch_id, origin, actor, entity_type, entity_id, op_ids_json, before_json, after_json, created_at)
       VALUES ('default', ?, 'api', 'test', 'asset', ?, '[]', NULL, '{}', ?)`,
      [newId(), old.id, Date.now()],
    );
    const plan = planAssetGc(ctx.driver);
    expect(plan.orphans).toEqual([]);
    expect(plan.inGrace).toBe(1);
  });

  it("keeps an asset referenced only from the trash (a tombstoned block, or a deleted page)", async () => {
    const livePage = createPage("Live");
    const gonePage = createPage("Gone");
    const fromBlock = storeAsset("in-deleted-block.png", 400);
    const fromPage = storeAsset("on-deleted-page.png", 400);
    const block = createBlock(livePage, `![](${fromBlock.path})`);
    createBlock(gonePage, `![](${fromPage.path})`);
    tombstoneBlock(block);
    tombstonePage(gonePage);
    const plan = planAssetGc(ctx.driver);
    expect(plan.orphans).toEqual([]);
    expect(plan.keptByTrashOnly).toBe(2);
  });
});

describe("planAssetGc — page history (B-91 follow-up)", () => {
  it("keeps an asset that only page history still references, so restoring that version keeps its image", async () => {
    const page = createPage("Edited");
    const pic = storeAsset("history.png", 400);
    const block = createBlock(page, `before ![](${pic.path}) after`);
    // The link goes away by an EDIT — nothing lands in the trash. `batch.undo` of this write (the
    // History view's "restore this version") would bring the link back from `changes.before_json`.
    const hlc = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: block,
          payload: { kind: "block.text", content: "before after" },
        },
      ],
      { origin: "user", actor: "test" },
    );
    // Everything, including the edit, is well past the grace period.
    ctx.driver.run("UPDATE changes SET created_at = ?", [Date.now() - 400 * DAY]);

    const plan = planAssetGc(ctx.driver);
    expect(plan.orphans).toEqual([]);
    expect(plan.keptByHistoryOnly).toBe(1);
    const report = await runGc(ctx, { dataDir, noBackup: true });
    expect(report.assets.removed).toBe(0);
    expect(assetFiles()).toEqual([`${pic.id}.${pic.ext}`]);
  });

  it("does not count an asset's own upload audit row as a reference", async () => {
    const orphan = storeAsset("never-embedded.png", 400);
    const plan = planAssetGc(ctx.driver);
    expect(plan.orphans.map((o) => o.id)).toEqual([orphan.id]);
    expect(plan.keptByHistoryOnly).toBe(0);
  });
});

describe("runGc — assets", () => {
  it("dry-run lists the orphans and removes nothing", async () => {
    const page = createPage("Dry");
    const kept = storeAsset("kept.png", 400);
    createBlock(page, `![](${kept.path})`);
    const orphan = storeAsset("orphan.png", 400);
    const filesBefore = assetFiles();

    const report = await runGc(ctx, { dataDir, dryRun: true });
    expect(report.assets.orphans.map((o) => o.id)).toEqual([orphan.id]);
    expect(report.assets.removed).toBe(0);
    expect(report.backupPath).toBeUndefined();
    expect(assetFiles()).toEqual(filesBefore);
    expect(liveAssetIds().sort()).toEqual([kept.id, orphan.id].sort());
  });

  it("a real run unlinks the file, tombstones the row, and takes a backup that still has the file", async () => {
    const page = createPage("Real");
    const kept = storeAsset("kept.png", 400);
    createBlock(page, `![](${kept.path})`);
    const orphan = storeAsset("orphan.png", 400);
    expect(assetFiles()).toContain(`${orphan.id}.${orphan.ext}`);

    // No device has synced, so the op-log half refuses -- and the asset half must run anyway.
    const report = await runGc(ctx, { dataDir });
    expect(report.refused).toBe(true);
    expect(report.assets.removed).toBe(1);
    expect(report.assets.reclaimedBytes).toBeGreaterThan(0);
    expect(report.backupPath).toBeDefined();

    expect(assetFiles()).toEqual([`${kept.id}.${kept.ext}`]);
    expect(liveAssetIds()).toEqual([kept.id]);
    // Tombstoned, not hard-deleted: the row is still there to explain the missing file.
    expect(
      ctx.driver.get<{ deleted_at: number | null }>("SELECT deleted_at FROM asset WHERE id = ?", [
        orphan.id,
      ])?.deleted_at,
    ).not.toBeNull();

    // The safety net actually holds the removed file.
    const restoreDir = mkdtempSync(join(tmpdir(), "nooklet-gc-restore-"));
    try {
      await restoreBackup(report.backupPath as string, { dataDir: restoreDir });
      expect(existsSync(join(restoreDir, "assets", `${orphan.id}.${orphan.ext}`))).toBe(true);
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("removes nothing, and takes no backup, when every asset is referenced or in grace", async () => {
    const page = createPage("Quiet");
    const kept = storeAsset("kept.png", 400);
    createBlock(page, `![](${kept.path})`);
    storeAsset("fresh.png");
    const report = await runGc(ctx, { dataDir });
    expect(report.assets.removed).toBe(0);
    expect(report.assets.inGrace).toBe(1);
    expect(report.backupPath).toBeUndefined();
    expect(assetFiles()).toHaveLength(2);
  });

  it("copes with a row whose file is already missing on disk", async () => {
    const orphan = storeAsset("ghost.png", 400);
    rmSync(join(dataDir, "assets", `${orphan.id}.${orphan.ext}`));
    const report = await runGc(ctx, { dataDir, noBackup: true });
    expect(report.assets.removed).toBe(1);
    expect(liveAssetIds()).toEqual([]);
  });
});

describe("GC preserves rebuild() equivalence (gc.ts's documented safety property)", () => {
  it("rebuild(drop) then applyOps(retain) reproduces the exact live state, on a real graph fixture", async () => {
    seedGraph();
    // A second "device" catches up mid-log, a third is fully caught up -- gives the floor some
    // ops on either side of it, i.e. both a non-empty drop and a non-empty retain.
    createPage("Later Page");
    createBlock(createPage("Even Later"), "one more block for good measure");

    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-mid", Math.floor(tip / 2));
    registerDevice("dev-caught-up", tip);

    const { floor, drop, retain } = planGc(ctx.driver);
    expect(floor.floor).not.toBeNull();
    expect(drop.length).toBeGreaterThan(0);
    expect(retain.length).toBeGreaterThan(0);

    const liveState = dumpState(ctx.driver);

    const scratch = newScratchDriver();
    rebuild(scratch, drop);
    const afterDrop = applyOps(scratch, retain);
    expect(afterDrop.rejected).toBe(0);

    expect(dumpState(scratch)).toEqual(liveState);
  });
});
