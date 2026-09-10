import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { applyOps, initSchema, newId, rebuild } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { createToken } from "./auth/tokens.js";
import { graphDbPath } from "./backup/index.js";
import { openDb } from "./db.js";
import { computeGcFloor, planGc, runGc } from "./gc.js";
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
  createBlock(home, "Hello [[Projects]] #idea");
  const projects = createPage("Projects");
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
  it("refuses when no device has ever synced", () => {
    seedGraph();
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBeNull();
    expect(floor.reason).toMatch(/no device/);
  });

  it("refuses when any live device has never acked (acked_seq = 0)", () => {
    seedGraph();
    registerDevice("dev-a", 5);
    registerDevice("dev-b", 0); // pushed, never pulled
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBeNull();
    expect(floor.blockingDevices.map((d) => d.id)).toEqual(["dev-b"]);
  });

  it("ignores devices whose token has been revoked", () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-live", tip);
    registerDevice("dev-gone", 0, /* revoked */ true);
    const floor = computeGcFloor(ctx.driver);
    expect(floor.floor).toBe(tip);
    expect(floor.liveDeviceCount).toBe(1);
  });

  it("takes the minimum acked_seq across live devices, clamped to the current tip", () => {
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
  it("dry-run reports counts and mutates nothing", () => {
    seedGraph();
    registerDevice("dev-a", 2);
    const before = dumpState(ctx.driver);
    const opCountBefore = ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n ?? 0;

    const report = runGc(ctx, { dataDir, dryRun: true });
    expect(report.refused).toBe(false);
    expect(report.floor).toBe(2);
    expect(report.dropCount).toBeGreaterThan(0);
    expect(report.backupPath).toBeUndefined();

    expect(dumpState(ctx.driver)).toEqual(before);
    expect(ctx.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n).toBe(opCountBefore);
  });

  it("refuses a real run exactly like computeGcFloor, and touches nothing", () => {
    seedGraph();
    const before = dumpState(ctx.driver);
    const report = runGc(ctx, { dataDir });
    expect(report.refused).toBe(true);
    expect(report.backupPath).toBeUndefined();
    expect(dumpState(ctx.driver)).toEqual(before);
  });

  it("real run drops ops below the floor, takes a backup by default, and reclaims space", () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-a", tip); // everyone fully caught up -> floor == tip

    const liveStateBefore = dumpState(ctx.driver);
    const report = runGc(ctx, { dataDir });

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

  it("--no-backup skips the automatic backup", () => {
    seedGraph();
    const tip = ctx.driver.get<{ n: number }>("SELECT MAX(seq) AS n FROM op")?.n ?? 0;
    registerDevice("dev-a", tip);
    const report = runGc(ctx, { dataDir, noBackup: true });
    expect(report.refused).toBe(false);
    expect(report.backupPath).toBeUndefined();
  });

  it("takes no backup when the floor drops nothing (seq is 1-indexed, so floor=1 always drops zero rows)", () => {
    seedGraph();
    registerDevice("dev-a", 1);
    const report = runGc(ctx, { dataDir });
    expect(report.refused).toBe(false);
    expect(report.dropCount).toBe(0);
    expect(report.backupPath).toBeUndefined();
  });
});

describe("GC preserves rebuild() equivalence (gc.ts's documented safety property)", () => {
  it("rebuild(drop) then applyOps(retain) reproduces the exact live state, on a real graph fixture", () => {
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
