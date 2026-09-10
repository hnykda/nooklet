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
import { compareHlc, Hlc } from "../hlc.js";
import { newId } from "../ids.js";
import { TASK_MARKERS } from "../model.js";
import type { LoggedOp, Op } from "../ops.js";
import { makeOp } from "../ops.js";
import { applyOps, rebuild } from "./apply-ops.js";
import type { SqlDriver } from "./driver.js";
import { planOpLogGc } from "./gc.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";
import { getBlock, listBlockProps } from "./queries.js";
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

/** Human-readable op log, HLC-ordered, for failure output — printing the abstract fast-check seeds
 * alone (`blockSeed`, `parentSeed`, ...) is not enough to reconstruct what actually happened. */
function formatOpLogForDebug(ops: Iterable<Op>): string {
  const sorted = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc));
  if (sorted.length === 0) return "(no ops)";
  return sorted
    .map((o) => `  ${o.hlc} dev=${o.device} entity=${o.entity} ${JSON.stringify(o.payload)}`)
    .join("\n");
}

/** Run `fn`; on any thrown assertion, dump every op any device has authored/seen (HLC-ordered)
 * before rethrowing, so a property-test failure is debuggable from the test output alone. */
function withOpLogOnFailure(devices: readonly Device[], label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const allOps = new Map<string, Op>();
    for (const d of devices) for (const [id, op] of d.log) allOps.set(id, op);
    console.error(`${label} failed — op log:\n${formatOpLogForDebug(allOps.values())}`);
    throw err;
  }
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

  withOpLogOnFailure(devices, "runScenario", () => runScenarioBody(devices, actions));
}

function runScenarioBody(devices: Device[], actions: Action[]): void {
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

  // (c) no op is ever lost: every op any device authored is present, with the *same* status, in
  // every device's own `op` log table after a full sync — not just reflected in the state tables.
  const authored = new Map<string, Op>();
  for (const d of devices) for (const [id, op] of d.log) authored.set(id, op);
  const opStatusPerDevice = devices.map(
    (d) =>
      new Map(
        d.driver
          .all<{ id: string; status: "applied" | "noop" | "rejected" }>("SELECT id, status FROM op")
          .map((r) => [r.id, r.status] as const),
      ),
  );
  for (const id of authored.keys()) {
    const statuses = opStatusPerDevice.map((rows) => rows.get(id));
    for (const [i, s] of statuses.entries()) {
      if (s === undefined) {
        throw new Error(`op ${id} is missing from device index ${i}'s op log after full sync`);
      }
    }
    const first = statuses[0];
    for (let i = 1; i < statuses.length; i++) {
      if (statuses[i] !== first) {
        throw new Error(
          `op ${id} has divergent status across devices: ${JSON.stringify(statuses)}`,
        );
      }
    }
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

// -------------------------------------------------------------------------------------------
// A device offline for a long stretch, reconnecting with a large backlog (research/03 §9: "Hand-
// rolled sync bug (lost update, divergence)" / ADR 003's HLC-ordering guarantee across a big gap).
// -------------------------------------------------------------------------------------------

/** `actionArb` minus `sync`: every generated action accumulates in some device's own local log,
 * with `runScenario`'s single mandatory *final* sync as the only point anything is exchanged —
 * i.e. every device is "offline" for the entire scenario and reconnects once, all at once. */
const noIntermediateSyncArb: fc.Arbitrary<Action> = actionArb.filter((a) => a.t !== "sync");

describe("long-offline device reconnects with a large backlog", () => {
  it("a big backlog delivered in one go still HLC-orders correctly and converges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3 }),
        fc.array(noIntermediateSyncArb, { minLength: 40, maxLength: 90 }),
        (deviceCount, actions) => {
          runScenario(deviceCount, [{ t: "createPage", dev: 0 }, ...actions] as Action[]);
        },
      ),
      { numRuns: 40 },
    );
  }, 30_000);
});

// -------------------------------------------------------------------------------------------
// Three-way concurrent moves of the same subtree: a genuine 3-cycle attempt (X under Y, Y under
// Z, Z under X), one move authored by each of 3 devices, all issued before any device has seen
// another's move. Exercises the cycle-correction path under real concurrency (not the
// single-device case `apply-ops.test.ts` already covers).
// -------------------------------------------------------------------------------------------

describe("three-way concurrent moves of the same subtree", () => {
  const allOrders: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  for (const order of allOrders) {
    it(`rotation X→Y, Y→Z, Z→X issued in HLC order ${JSON.stringify(order)} never produces a cycle`, () => {
      let clockNow = BASE;
      const sharedNow = () => clockNow++;
      const devices = DEVICE_IDS.slice(0, 3).map((id) => makeDevice(id, sharedNow));

      withOpLogOnFailure(devices, "3-way rotation", () => {
        const [d0] = devices as [Device, Device, Device];
        const pageId = newId();
        applyLocal(
          d0,
          makeOp(d0.clock.next(), d0.id, pageId, {
            kind: "page.create",
            name: pageId,
            journalDay: null,
            createdAt: BASE,
          }),
        );
        const [xId, yId, zId] = [newId(), newId(), newId()];
        for (const [i, blockId] of [xId, yId, zId].entries()) {
          applyLocal(
            d0,
            makeOp(d0.clock.next(), d0.id, blockId, {
              kind: "block.create",
              place: { pageId, parentId: null, order: `k${i}` },
              content: blockId,
              createdAt: BASE,
            }),
          );
        }
        // Every device starts from the same tree (X, Y, Z as top-level siblings) before the
        // concurrent rotation is issued.
        syncAll(devices);

        // moves[0] = X under Y, moves[1] = Y under Z, moves[2] = Z under X — a full rotation.
        const moves: ReadonlyArray<readonly [string, string]> = [
          [xId, yId],
          [yId, zId],
          [zId, xId],
        ];
        for (const idx of order) {
          const [blockId, newParentId] = moves[idx] as readonly [string, string];
          const dev = devices[idx] as Device;
          applyLocal(
            dev,
            makeOp(dev.clock.next(), dev.id, blockId, {
              kind: "block.place",
              place: { pageId, parentId: newParentId, order: `m${idx}` },
            }),
          );
        }

        syncAll(devices);
        for (const d of devices) assertNoCycles(d.driver);

        const reference = dumpState(d0.driver);
        for (const d of devices.slice(1)) expect(dumpState(d.driver)).toEqual(reference);

        // A full 3-cycle can never all succeed: exactly one of the three rotating moves is
        // rejected regardless of the HLC order they were issued in, the other two apply.
        const placeStatuses = d0.driver.all<{ status: string }>(
          "SELECT status FROM op WHERE kind = 'block.place'",
        );
        expect(placeStatuses.filter((r) => r.status === "rejected").length).toBe(1);
        expect(placeStatuses.filter((r) => r.status === "applied").length).toBe(2);
      });
    });
  }
});

// -------------------------------------------------------------------------------------------
// Interleaved delete/restore/move of THE SAME block, across devices, with no ordering guarantee
// between them — the delete/move interaction research/03 §6.4 calls out ("the block ends up
// tombstoned at its new location (restorable)"), stressed under real multi-device concurrency
// rather than a single-device sequence.
// -------------------------------------------------------------------------------------------

type DrmAction =
  | { t: "delete"; dev: number }
  | { t: "restore"; dev: number }
  | { t: "move"; dev: number; parentSeed: number }
  | { t: "sync" };

const drmActionArb: fc.Arbitrary<DrmAction> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("delete" as const), dev: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("restore" as const), dev: fc.nat() }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("move" as const),
      dev: fc.nat(),
      parentSeed: fc.nat(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("sync" as const) }) },
);

describe("interleaved delete/restore/move of the same block", () => {
  it("converges regardless of interleaving, and place/delete never clobber each other", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(drmActionArb, { minLength: 10, maxLength: 40 }),
        (deviceCount, actions) => {
          let clockNow = BASE;
          const sharedNow = () => clockNow++;
          const devices = DEVICE_IDS.slice(0, deviceCount).map((id) => makeDevice(id, sharedNow));

          withOpLogOnFailure(devices, "interleaved delete/restore/move", () => {
            const d0 = devices[0] as Device;
            const pageId = newId();
            const targetId = newId();
            const otherIds = [newId(), newId()];
            applyLocal(
              d0,
              makeOp(d0.clock.next(), d0.id, pageId, {
                kind: "page.create",
                name: pageId,
                journalDay: null,
                createdAt: BASE,
              }),
            );
            for (const id of [targetId, ...otherIds]) {
              applyLocal(
                d0,
                makeOp(d0.clock.next(), d0.id, id, {
                  kind: "block.create",
                  place: { pageId, parentId: null, order: `k${id}` },
                  content: id,
                  createdAt: BASE,
                }),
              );
            }
            syncAll(devices);

            for (const action of actions) {
              if (action.t === "sync") {
                syncAll(devices);
                for (const d of devices) assertNoCycles(d.driver);
                continue;
              }
              const dev = devices[
                ((action.dev % devices.length) + devices.length) % devices.length
              ] as Device;
              switch (action.t) {
                case "delete":
                  applyLocal(
                    dev,
                    makeOp(dev.clock.next(), dev.id, targetId, {
                      kind: "block.delete",
                      deletedAt: BASE,
                    }),
                  );
                  break;
                case "restore":
                  applyLocal(
                    dev,
                    makeOp(dev.clock.next(), dev.id, targetId, {
                      kind: "block.delete",
                      deletedAt: null,
                    }),
                  );
                  break;
                case "move": {
                  const parentId =
                    action.parentSeed % 3 === 0
                      ? null
                      : (pick(otherIds, action.parentSeed) ?? null);
                  applyLocal(
                    dev,
                    makeOp(dev.clock.next(), dev.id, targetId, {
                      kind: "block.place",
                      place: { pageId, parentId, order: `m${action.parentSeed % 1000}` },
                    }),
                  );
                  break;
                }
                default: {
                  const exhaustive: never = action;
                  throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
                }
              }
            }

            syncAll(devices);
            for (const d of devices) assertNoCycles(d.driver);

            const reference = dumpState(d0.driver);
            for (const d of devices.slice(1)) expect(dumpState(d.driver)).toEqual(reference);

            // Independent fields on the SAME hotly-contested block: whichever field (delete vs.
            // place) has ops must land on exactly its own max-HLC writer, unaffected by the other
            // field's traffic.
            const targetOps = [...d0.log.values()].filter((o) => o.entity === targetId);
            const row = getBlock(d0.driver, targetId);
            expect(row).toBeDefined();

            const placeCandidates = targetOps.filter(
              (o) => o.payload.kind === "block.create" || o.payload.kind === "block.place",
            );
            const maxPlace = placeCandidates.reduce((a, b) =>
              compareHlc(a.hlc, b.hlc) > 0 ? a : b,
            );
            expect(row?.placeHlc).toBe(maxPlace.hlc);

            const deleteOps = targetOps.filter((o) => o.payload.kind === "block.delete");
            if (deleteOps.length > 0) {
              const maxDelete = deleteOps.reduce((a, b) => (compareHlc(a.hlc, b.hlc) > 0 ? a : b));
              expect(row?.deletedHlc).toBe(maxDelete.hlc);
            } else {
              expect(row?.deletedHlc).toBeNull();
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -------------------------------------------------------------------------------------------
// Property writes racing text writes on the SAME block: per-field HLCs (ADR 003) mean a
// concurrent `block.text` and `block.prop` on one block must never clobber each other, no matter
// how densely interleaved across devices.
// -------------------------------------------------------------------------------------------

type RaceAction =
  | { t: "text"; dev: number; seed: number }
  | { t: "prop"; dev: number; keySeed: number; valueSeed: number }
  | { t: "sync" };

const raceActionArb: fc.Arbitrary<RaceAction> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant("text" as const), dev: fc.nat(), seed: fc.nat() }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("prop" as const),
      dev: fc.nat(),
      keySeed: fc.nat(),
      valueSeed: fc.nat(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("sync" as const) }) },
);

/** Two prop keys with clean "starts unset" semantics: `area` (generic, routed to `block_prop`)
 * and `scheduled` (a reserved key with its own dedicated column+HLC, but — unlike marker/priority
 * — NOT given a baseline HLC by `block.create`), so a field's current HLC is exactly the max HLC
 * of the ops this test issued for it, with no creation-time wrinkle to account for. */
function racePropWrite(keySeed: number, valueSeed: number): { key: string; value: string } {
  if (keySeed % 2 === 0) return { key: "area", value: `val-${valueSeed % 10}` };
  const day = (Math.abs(valueSeed) % 27) + 1;
  return { key: "scheduled", value: `2026-09-${String(day).padStart(2, "0")}` };
}

describe("property writes racing text writes on the same block", () => {
  it("content and each prop key converge independently to their own max-HLC writer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(raceActionArb, { minLength: 10, maxLength: 40 }),
        (deviceCount, actions) => {
          let clockNow = BASE;
          const sharedNow = () => clockNow++;
          const devices = DEVICE_IDS.slice(0, deviceCount).map((id) => makeDevice(id, sharedNow));

          withOpLogOnFailure(devices, "prop-vs-text race", () => {
            const d0 = devices[0] as Device;
            const pageId = newId();
            const targetId = newId();
            applyLocal(
              d0,
              makeOp(d0.clock.next(), d0.id, pageId, {
                kind: "page.create",
                name: pageId,
                journalDay: null,
                createdAt: BASE,
              }),
            );
            applyLocal(
              d0,
              makeOp(d0.clock.next(), d0.id, targetId, {
                kind: "block.create",
                place: { pageId, parentId: null, order: "k0" },
                content: "initial",
                createdAt: BASE,
              }),
            );
            syncAll(devices);

            for (const action of actions) {
              if (action.t === "sync") {
                syncAll(devices);
                for (const d of devices) assertNoCycles(d.driver);
                continue;
              }
              const dev = devices[
                ((action.dev % devices.length) + devices.length) % devices.length
              ] as Device;
              if (action.t === "text") {
                applyLocal(
                  dev,
                  makeOp(dev.clock.next(), dev.id, targetId, {
                    kind: "block.text",
                    content: `text-${action.seed}`,
                  }),
                );
              } else {
                const { key, value } = racePropWrite(action.keySeed, action.valueSeed);
                applyLocal(
                  dev,
                  makeOp(dev.clock.next(), dev.id, targetId, { kind: "block.prop", key, value }),
                );
              }
            }

            syncAll(devices);
            for (const d of devices) assertNoCycles(d.driver);

            const reference = dumpState(d0.driver);
            for (const d of devices.slice(1)) expect(dumpState(d.driver)).toEqual(reference);

            const targetOps = [...d0.log.values()].filter((o) => o.entity === targetId);
            const row = getBlock(d0.driver, targetId);
            expect(row).toBeDefined();

            const textOps = targetOps.filter((o) => o.payload.kind === "block.text");
            if (textOps.length > 0) {
              const maxText = textOps.reduce((a, b) => (compareHlc(a.hlc, b.hlc) > 0 ? a : b));
              expect(row?.contentHlc).toBe(maxText.hlc);
              if (maxText.payload.kind === "block.text") {
                expect(row?.content).toBe(maxText.payload.content);
              }
            }

            const areaOps = targetOps.filter(
              (o) => o.payload.kind === "block.prop" && o.payload.key === "area",
            );
            if (areaOps.length > 0) {
              const maxArea = areaOps.reduce((a, b) => (compareHlc(a.hlc, b.hlc) > 0 ? a : b));
              const prop = listBlockProps(d0.driver, targetId).find((p) => p.key === "area");
              expect(prop?.hlc).toBe(maxArea.hlc);
            }

            const schedOps = targetOps.filter(
              (o) => o.payload.kind === "block.prop" && o.payload.key === "scheduled",
            );
            if (schedOps.length > 0) {
              const maxSched = schedOps.reduce((a, b) => (compareHlc(a.hlc, b.hlc) > 0 ? a : b));
              expect(row?.scheduledHlc).toBe(maxSched.hlc);
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -------------------------------------------------------------------------------------------
// Op-log GC (research/03 §6.5, `./gc.ts`'s `planOpLogGc`). The safety property under test: a
// device that has already caught up to exactly the floor (i.e. has applied every op with
// `seq < floor` — which, by the floor's own definition as `MIN(device.acked_seq)`, is EVERY real
// device, since none can be behind the minimum) can reach the true current state using ONLY
// `plan.retain` (`seq >= floor`) — dropping `plan.drop` therefore loses nothing any real device
// will ever ask for again.
//
// IMPORTANT — a hazard this suite's first draft caught (see the file's own commit history /
// PR description for the write-up): this is NOT the same as "copy a snapshot of the CURRENT
// state, then blindly reapply every retained op on top." That formulation is unsound and this
// test used to (wrongly) assert it: `applyOps`'s `resolvePlace` resolves `block.place.parentId`
// against whatever the driver's parent row looks like *right now* (a live block, or "doesn't
// exist / is deleted -> fall back to null") — it has no notion of "as of when this op was
// originally authored." Reprocessing an OLD `block.place` op against a driver that has since
// moved PAST it (e.g. the referenced parent was deleted by a *later* op already baked into that
// "current" snapshot) can silently null out a parent that op never actually detached, changing
// the outcome. This is exactly why `applyOps` guards every op through the `op` table's
// "already recorded -> skip" check in normal operation (push/pull), and precisely why GC and
// bootstrap must only ever pair `plan.retain` with a snapshot taken AT OR BEFORE the floor
// (reflecting exactly `plan.drop`'s effect, never anything from `plan.retain` itself) — never
// with a snapshot of "current." `planOpLogGc`'s doc comment and `gc.ts`'s file header both flag
// this explicitly. The corrected property below reflects the pairing that is actually safe.
// -------------------------------------------------------------------------------------------

describe("op-log GC", () => {
  it("planOpLogGc partitions correctly, and a device caught up to the floor can reach current state using only the retained tail", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(actionArb, { minLength: 15, maxLength: 40 }),
        fc.nat(),
        (deviceCount, actions, floorSeed) => {
          let clockNow = BASE;
          const sharedNow = () => clockNow++;
          const devices = DEVICE_IDS.slice(0, deviceCount).map((id) => makeDevice(id, sharedNow));

          withOpLogOnFailure(devices, "op-log GC", () => {
            runScenarioBody(devices, actions);
            syncAll(devices);

            // `seq` = order each op was first authored across the whole simulation — a stand-in
            // for server arrival order, deliberately NOT re-sorted by HLC (arrival order and HLC
            // order can and do diverge; see file header).
            const merged = [...(devices[0] as Device).log.values()];
            const logged: LoggedOp[] = merged.map((op, i) => ({
              ...op,
              seq: i,
              status: "applied",
            }));
            const floor = logged.length === 0 ? 0 : floorSeed % (logged.length + 1);

            const plan = planOpLogGc(logged, floor);
            expect(plan.drop.length + plan.retain.length).toBe(logged.length);
            expect(plan.drop.every((o) => o.seq < floor)).toBe(true);
            expect(plan.retain.every((o) => o.seq >= floor)).toBe(true);

            const current = (devices[0] as Device).driver;

            // A device already caught up to the floor: its state reflects exactly `plan.drop`
            // (every op with `seq < floor`), nothing more. Bringing it current needs only
            // `plan.retain` applied on top, in the same causal (HLC) order `applyOps` always
            // uses — never anything from `plan.drop` again.
            const caughtUpToFloor = newDriver();
            rebuild(caughtUpToFloor, plan.drop);
            applyOps(caughtUpToFloor, plan.retain);
            expect(dumpState(caughtUpToFloor)).toEqual(dumpState(current));
          });
        },
      ),
      { numRuns: 60 },
    );
  }, 30_000);
});
