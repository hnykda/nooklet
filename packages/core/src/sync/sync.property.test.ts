/**
 * Multi-device convergence property tests (task requirement: "simulate 2-4 devices ... assert
 * every device's state is byte-identical after a full sync; rebuild() reproduces it; no cycle").
 *
 * Topology: each simulated device has its own `Hlc` clock (sharing one monotonically-increasing
 * `now()` source across devices so `Hlc.receive()` never trips the drift guard) and its own
 * in-memory `node:sqlite` database. Between "sync" steps a device applies only its own newly
 * created ops, incrementally, via `applyOps` — safe because a device's own ops are always
 * strictly HLC-increasing relative to each other. AT a sync step, every device's full merged op
 * log is replayed via `rebuild` (HLC-ordered) on every device: see `apply-ops.ts`'s file header
 * for why this — not incrementally trickling in whatever a device happens to receive first — is
 * what actually guarantees convergence once a `block.place` cycle check is in the mix.
 */

import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Hlc } from "../hlc.js";
import { newId } from "../ids.js";
import { TASK_MARKERS } from "../model.js";
import type { Op } from "../ops.js";
import { makeOp } from "../ops.js";
import { applyOps, rebuild } from "./apply-ops.js";
import type { SqlDriver } from "./driver.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";
import { initSchema } from "./schema.js";

const DEVICE_IDS = ["aaaaaaa0", "aaaaaaa1", "aaaaaaa2", "aaaaaaa3"];
const BASE = Date.UTC(2026, 8, 10, 0, 0, 0);

function newDriver(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const driver = createNodeSqliteDriver(db);
  initSchema(driver);
  return driver;
}

interface Device {
  id: string;
  clock: Hlc;
  driver: SqlDriver;
  log: Map<string, Op>; // ops this device has seen (own + synced), keyed by op id
}

function makeDevice(id: string, now: () => number): Device {
  return { id, clock: new Hlc(id, undefined, now), driver: newDriver(), log: new Map() };
}

/** Apply one locally-authored op immediately and record it in the device's own log. */
function applyLocal(dev: Device, op: Op): void {
  applyOps(dev.driver, [op]);
  dev.log.set(op.id, op);
}

/** All devices exchange every op they've seen; each then canonically replays (see file header). */
function syncAll(devices: Device[]): void {
  const merged = new Map<string, Op>();
  for (const d of devices) for (const [id, op] of d.log) merged.set(id, op);
  const all = [...merged.values()];
  for (const d of devices) {
    d.log = merged;
    d.clock.receive(all.reduce((max, o) => (o.hlc > max ? o.hlc : max), d.clock.last));
    rebuild(d.driver, all);
  }
}

function dumpState(driver: SqlDriver) {
  return {
    pages: driver.all("SELECT * FROM page ORDER BY id"),
    blocks: driver.all("SELECT * FROM block ORDER BY id"),
    blockProps: driver.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: driver.all("SELECT * FROM page_prop ORDER BY page_id, key"),
  };
}

/** Every block's ancestor chain must terminate without revisiting a node. */
function assertNoCycles(driver: SqlDriver): void {
  const rows = driver.all<{ id: string; parent_id: string | null }>(
    "SELECT id, parent_id FROM block",
  );
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
  for (const row of rows) {
    const seen = new Set<string>();
    let cur: string | null = row.id;
    while (cur !== null) {
      if (seen.has(cur)) throw new Error(`cycle detected reaching back to ${cur} from ${row.id}`);
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
      if (seen.size > rows.length + 1)
        throw new Error(`ancestor walk from ${row.id} did not terminate`);
    }
  }
}

function livePages(driver: SqlDriver): string[] {
  return driver
    .all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL")
    .map((r) => r.id);
}

function liveBlocksOnPage(
  driver: SqlDriver,
  pageId: string,
): Array<{ id: string; parent_id: string | null }> {
  return driver.all("SELECT id, parent_id FROM block WHERE page_id = ? AND deleted_at IS NULL", [
    pageId,
  ]);
}

function deletedBlocks(driver: SqlDriver): string[] {
  return driver
    .all<{ id: string }>("SELECT id FROM block WHERE deleted_at IS NOT NULL")
    .map((r) => r.id);
}

function descendantsOf(driver: SqlDriver, blockId: string): Set<string> {
  const rows = driver.all<{ id: string; parent_id: string | null }>(
    "SELECT id, parent_id FROM block",
  );
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const arr = children.get(r.parent_id) ?? [];
    arr.push(r.id);
    children.set(r.parent_id, arr);
  }
  const out = new Set<string>();
  const stack = [...(children.get(blockId) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const c of children.get(cur) ?? []) stack.push(c);
  }
  return out;
}

function pick<T>(pool: readonly T[], seed: number): T | undefined {
  if (pool.length === 0) return undefined;
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

function makePropWrite(
  keySeed: number,
  valueSeed: number,
  clear: boolean,
): { key: string; value: string | null } {
  const kind = ((keySeed % 4) + 4) % 4;
  if (kind === 0) return { key: "area", value: clear ? null : `val-${valueSeed % 10}` };
  if (kind === 1) {
    const marker = pick(TASK_MARKERS, valueSeed) as string;
    return { key: "marker", value: clear ? null : marker };
  }
  if (kind === 2) {
    const day = (Math.abs(valueSeed) % 27) + 1;
    return { key: "scheduled", value: clear ? null : `2026-09-${String(day).padStart(2, "0")}` };
  }
  const priority = pick(["A", "B", "C"] as const, valueSeed) as string;
  return { key: "priority", value: clear ? null : priority };
}

// -------------------------------------------------------------------------------------------
// Action generator: seeds only, resolved against live device state at interpretation time.
// -------------------------------------------------------------------------------------------

type Action =
  | { t: "createPage"; dev: number }
  | { t: "createBlock"; dev: number; pageSeed: number; parentSeed: number }
  | { t: "editText"; dev: number; blockSeed: number; textSeed: number }
  | { t: "move"; dev: number; blockSeed: number; parentSeed: number; adversarial: boolean }
  | {
      t: "setProp";
      dev: number;
      blockSeed: number;
      keySeed: number;
      valueSeed: number;
      clear: boolean;
    }
  | { t: "deleteBlock"; dev: number; blockSeed: number }
  | { t: "restoreBlock"; dev: number; blockSeed: number }
  | { t: "deletePage"; dev: number; pageSeed: number }
  | { t: "sync" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("createPage" as const), dev: fc.nat() }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("createBlock" as const),
      dev: fc.nat(),
      pageSeed: fc.nat(),
      parentSeed: fc.nat(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("editText" as const),
      dev: fc.nat(),
      blockSeed: fc.nat(),
      textSeed: fc.nat(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("move" as const),
      dev: fc.nat(),
      blockSeed: fc.nat(),
      parentSeed: fc.nat(),
      adversarial: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("setProp" as const),
      dev: fc.nat(),
      blockSeed: fc.nat(),
      keySeed: fc.nat(),
      valueSeed: fc.nat(),
      clear: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("deleteBlock" as const),
      dev: fc.nat(),
      blockSeed: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("restoreBlock" as const),
      dev: fc.nat(),
      blockSeed: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("deletePage" as const),
      dev: fc.nat(),
      pageSeed: fc.nat(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("sync" as const) }) },
);

function runScenario(deviceCount: number, actions: Action[]): void {
  let clockNow = BASE;
  const sharedNow = () => clockNow++;
  const devices = DEVICE_IDS.slice(0, deviceCount).map((id) => makeDevice(id, sharedNow));

  for (const action of actions) {
    const devSeed = action.t === "sync" ? 0 : action.dev;
    const dev = devices[((devSeed % devices.length) + devices.length) % devices.length] as Device;

    switch (action.t) {
      case "createPage": {
        const id = newId();
        const wall = dev.clock.next();
        applyLocal(
          dev,
          makeOp(wall, dev.id, id, {
            kind: "page.create",
            name: id,
            journalDay: null,
            createdAt: BASE,
          }),
        );
        break;
      }
      case "createBlock": {
        let pages = livePages(dev.driver);
        if (pages.length === 0) {
          const id = newId();
          applyLocal(
            dev,
            makeOp(dev.clock.next(), dev.id, id, {
              kind: "page.create",
              name: id,
              journalDay: null,
              createdAt: BASE,
            }),
          );
          pages = livePages(dev.driver);
        }
        const pageId = pick(pages, action.pageSeed) as string;
        const siblings = liveBlocksOnPage(dev.driver, pageId);
        const parent = action.parentSeed % 3 === 0 ? undefined : pick(siblings, action.parentSeed);
        const blockId = newId();
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, blockId, {
            kind: "block.create",
            place: { pageId, parentId: parent?.id ?? null, order: `k${action.parentSeed % 1000}` },
            content: `block-${blockId}`,
            createdAt: BASE,
          }),
        );
        break;
      }
      case "editText": {
        const pages = livePages(dev.driver);
        const anyPageBlocks = pages.flatMap((p) => liveBlocksOnPage(dev.driver, p));
        const target = pick(anyPageBlocks, action.blockSeed);
        if (!target) break;
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target.id, {
            kind: "block.text",
            content: `edited-${action.textSeed}`,
          }),
        );
        break;
      }
      case "move": {
        const pages = livePages(dev.driver);
        const anyPageBlocks = pages.flatMap((p) =>
          liveBlocksOnPage(dev.driver, p).map((b) => ({ ...b, pageId: p })),
        );
        const target = pick(anyPageBlocks, action.blockSeed);
        if (!target) break;
        let newParentId: string | null;
        if (action.adversarial) {
          const desc = [...descendantsOf(dev.driver, target.id)];
          newParentId = desc.length > 0 ? (pick(desc, action.parentSeed) as string) : target.id;
        } else {
          const sameSiblings = liveBlocksOnPage(dev.driver, target.pageId).filter(
            (b) => b.id !== target.id,
          );
          newParentId =
            action.parentSeed % 3 === 0
              ? null
              : (pick(sameSiblings, action.parentSeed)?.id ?? null);
        }
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target.id, {
            kind: "block.place",
            place: {
              pageId: target.pageId,
              parentId: newParentId,
              order: `m${action.parentSeed % 1000}`,
            },
          }),
        );
        break;
      }
      case "setProp": {
        const pages = livePages(dev.driver);
        const anyPageBlocks = pages.flatMap((p) => liveBlocksOnPage(dev.driver, p));
        const target = pick(anyPageBlocks, action.blockSeed);
        if (!target) break;
        const { key, value } = makePropWrite(action.keySeed, action.valueSeed, action.clear);
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target.id, { kind: "block.prop", key, value }),
        );
        break;
      }
      case "deleteBlock": {
        const pages = livePages(dev.driver);
        const anyPageBlocks = pages.flatMap((p) => liveBlocksOnPage(dev.driver, p));
        const target = pick(anyPageBlocks, action.blockSeed);
        if (!target) break;
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target.id, { kind: "block.delete", deletedAt: BASE }),
        );
        break;
      }
      case "restoreBlock": {
        const target = pick(deletedBlocks(dev.driver), action.blockSeed);
        if (!target) break;
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target, { kind: "block.delete", deletedAt: null }),
        );
        break;
      }
      case "deletePage": {
        const target = pick(livePages(dev.driver), action.pageSeed);
        if (!target) break;
        applyLocal(
          dev,
          makeOp(dev.clock.next(), dev.id, target, { kind: "page.delete", deletedAt: BASE }),
        );
        break;
      }
      case "sync": {
        syncAll(devices);
        for (const d of devices) assertNoCycles(d.driver);
        break;
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Final full sync, regardless of what the generated action sequence happened to include.
  syncAll(devices);

  for (const d of devices) assertNoCycles(d.driver);

  // (a) every device's state tables are byte-identical after a full sync.
  const reference = dumpState((devices[0] as Device).driver);
  for (const d of devices.slice(1)) {
    expect(dumpState(d.driver)).toEqual(reference);
  }

  // (b) rebuild() from each device's own op log, into a *fresh* database, reproduces that
  // device's converged state (not a tautology: this is a brand-new empty db and driver instance,
  // independent of whatever internal state the live one accumulated).
  for (const d of devices) {
    const fresh = newDriver();
    rebuild(fresh, [...d.log.values()]);
    expect(dumpState(fresh)).toEqual(dumpState(d.driver));
  }
}

describe("multi-device sync convergence", () => {
  it("2-4 devices converge to byte-identical state after a full sync, with no cycles ever", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(actionArb, { minLength: 10, maxLength: 35 }),
        (deviceCount, actions) => {
          runScenario(deviceCount, actions);
        },
      ),
      { numRuns: 200 },
    );
  }, 30_000);

  it("dense adversarial moves on a small block pool still never produce a cycle, and still converge", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3 }),
        fc.array(
          fc.oneof(
            fc.record({
              t: fc.constant("createBlock" as const),
              dev: fc.nat(),
              pageSeed: fc.nat(),
              parentSeed: fc.nat(),
            }),
            fc.record({
              t: fc.constant("move" as const),
              dev: fc.nat(),
              blockSeed: fc.nat(),
              parentSeed: fc.nat(),
              adversarial: fc.boolean(),
            }),
            fc.record({ t: fc.constant("sync" as const) }),
          ),
          { minLength: 15, maxLength: 40 },
        ),
        (deviceCount, actions) => {
          runScenario(deviceCount, [{ t: "createPage", dev: 0 }, ...actions] as Action[]);
        },
      ),
      { numRuns: 200 },
    );
  }, 30_000);
});
