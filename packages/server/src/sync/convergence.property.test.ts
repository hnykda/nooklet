/**
 * Server-mediated convergence (ADR 003 + ADR 026): devices with skewed clocks push to the real
 * `serverApplyOps` in arbitrary interleavings, the server mints and deletes reference pages (ADR
 * 024) in between, and pull-only replicas read the log in `seq` order exactly as `/sync/pull`
 * serves it (`./pull.ts`: `status = 'applied'`, `ORDER BY seq`), in arbitrary batch sizes. Every
 * replica must end byte-identical to the server, and `verify` must find no divergence.
 *
 * `packages/core/src/sync/sync.property.test.ts` covers the serverless half (every device replays
 * the merged log in HLC order). What it cannot cover is B-587: once a server decides, `seq` order
 * is the order of record and HLC order can disagree with it — a device whose clock lags, or that
 * minted in the same millisecond before it heard of the server's write, pushes a `page.create`
 * with an HLC older than the `page.delete` that freed its name. Small name pool, lagging clocks
 * and pushes without pulls make that shape common here; the replica applying with
 * `{ order: "hlc" }` instead is how this test was checked to fail (see ADR 026).
 */

import { applyOps, Hlc, initSchema, makeOp, newId, type Op, type SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { verifyRebuildParity } from "../verify.js";
import { dumpState } from "./sync-test-helpers.js";

const NAMES = ["Alpha", "Beta", "alpha"];
const CONTENTS = ["plain", "[[Alpha]]", "[[Beta]]", "#Beta and [[Alpha]]"];
const DEVICE_IDS = ["aaaaaaa1", "aaaaaaa2", "aaaaaaa3"];

type Action =
  | { t: "createPage"; dev: number; name: number }
  | { t: "deletePage"; dev: number; pick: number }
  | { t: "renamePage"; dev: number; pick: number; name: number }
  | { t: "createBlock"; dev: number; pick: number; content: number }
  | { t: "editBlock"; dev: number; pick: number; content: number }
  | { t: "push"; dev: number }
  | { t: "devicePull"; dev: number }
  | { t: "replicaPull"; replica: number; limit: number }
  | { t: "tick"; ms: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    t: fc.constant("createPage" as const),
    dev: fc.nat(2),
    name: fc.nat(NAMES.length - 1),
  }),
  fc.record({ t: fc.constant("deletePage" as const), dev: fc.nat(2), pick: fc.nat(50) }),
  fc.record({
    t: fc.constant("renamePage" as const),
    dev: fc.nat(2),
    pick: fc.nat(50),
    name: fc.nat(NAMES.length - 1),
  }),
  fc.record({
    t: fc.constant("createBlock" as const),
    dev: fc.nat(2),
    pick: fc.nat(50),
    content: fc.nat(CONTENTS.length - 1),
  }),
  fc.record({
    t: fc.constant("editBlock" as const),
    dev: fc.nat(2),
    pick: fc.nat(50),
    content: fc.nat(CONTENTS.length - 1),
  }),
  fc.record({ t: fc.constant("push" as const), dev: fc.nat(2) }),
  fc.record({ t: fc.constant("devicePull" as const), dev: fc.nat(2) }),
  fc.record({
    t: fc.constant("replicaPull" as const),
    replica: fc.nat(1),
    limit: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({ t: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 3 }) }),
);

/** An authoring device: a clock (possibly lagging the server by seconds), an outbox, and what it
 * has heard of — enough to mint plausible ops. Its own replica is `SyncClient`'s business and is
 * covered by `apps/web/src/sync/e2e.test.ts`; here it only authors. */
interface Device {
  id: string;
  clock: Hlc;
  outbox: Op[];
  cursor: number;
  pages: string[];
  blocks: Array<{ id: string; pageId: string }>;
}

/** A pull-only replica, applying exactly what `/sync/pull` would hand it. */
interface Replica {
  driver: SqlDriver;
  cursor: number;
}

function pullBatch(
  server: ServerContext,
  since: number,
  limit: number,
): Op[] & { cursor?: number } {
  const rows = server.driver.all<{
    seq: number;
    id: string;
    hlc: string;
    device_id: string;
    entity: string;
    payload_json: string;
  }>(
    `SELECT seq, id, hlc, device_id, entity, payload_json FROM op
     WHERE seq > ? AND status = 'applied' ORDER BY seq LIMIT ?`,
    [since, limit],
  );
  const ops = rows.map((r) => ({
    id: r.id,
    hlc: r.hlc,
    device: r.device_id,
    entity: r.entity,
    payload: JSON.parse(r.payload_json),
  })) as Op[] & { cursor?: number };
  ops.cursor = rows.length > 0 ? (rows[rows.length - 1] as { seq: number }).seq : since;
  return ops;
}

function replicaPull(server: ServerContext, r: Replica, limit: number): void {
  const batch = pullBatch(server, r.cursor, limit);
  if (batch.length > 0) applyOps(r.driver, batch, { order: "seq" });
  r.cursor = batch.cursor ?? r.cursor;
}

function newReplica(): Replica {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  return { driver, cursor: 0 };
}

function run(actions: Action[], lags: number[]): void {
  const server = createServerContext(openDb({ path: ":memory:" }));
  // Device time runs behind the server's real clock (never ahead: ADR 003 rejects > 60 s ahead).
  let t = Date.now() - 30_000;
  const devices: Device[] = DEVICE_IDS.map((id, i) => ({
    id,
    clock: new Hlc(id, undefined, () => t - (lags[i] ?? 0)),
    outbox: [],
    cursor: 0,
    pages: [],
    blocks: [],
  }));
  const replicas = [newReplica(), newReplica()];

  const mint = (d: Device, entity: string, payload: Op["payload"]) => {
    const op = makeOp(d.clock.next(), d.id, entity, payload);
    d.outbox.push(op);
    return op;
  };

  for (const a of actions) {
    switch (a.t) {
      case "tick":
        t += a.ms;
        break;
      case "createPage": {
        const d = devices[a.dev] as Device;
        const id = newId();
        mint(d, id, {
          kind: "page.create",
          name: NAMES[a.name] as string,
          journalDay: null,
          createdAt: t,
        });
        d.pages.push(id);
        break;
      }
      case "deletePage": {
        const d = devices[a.dev] as Device;
        const page = d.pages[a.pick % Math.max(1, d.pages.length)];
        if (page) mint(d, page, { kind: "page.delete", deletedAt: t });
        break;
      }
      case "renamePage": {
        const d = devices[a.dev] as Device;
        const page = d.pages[a.pick % Math.max(1, d.pages.length)];
        if (page) mint(d, page, { kind: "page.rename", name: NAMES[a.name] as string });
        break;
      }
      case "createBlock": {
        const d = devices[a.dev] as Device;
        const page = d.pages[a.pick % Math.max(1, d.pages.length)];
        if (!page) break;
        const id = newId();
        mint(d, id, {
          kind: "block.create",
          place: { pageId: page, parentId: null, order: `a${d.blocks.length}` },
          content: CONTENTS[a.content] as string,
          createdAt: t,
        });
        d.blocks.push({ id, pageId: page });
        break;
      }
      case "editBlock": {
        const d = devices[a.dev] as Device;
        const b = d.blocks[a.pick % Math.max(1, d.blocks.length)];
        if (b) mint(d, b.id, { kind: "block.text", content: CONTENTS[a.content] as string });
        break;
      }
      case "push": {
        const d = devices[a.dev] as Device;
        if (d.outbox.length === 0) break;
        const r = serverApplyOps(server, d.outbox, {
          origin: "sync",
          actor: d.id,
          deviceId: d.id,
        });
        // A push response's corrections reach the device's clock, like `SyncClient` does.
        for (const c of r.corrections) d.clock.receive(c.hlc);
        d.outbox = [];
        break;
      }
      case "devicePull": {
        const d = devices[a.dev] as Device;
        const batch = pullBatch(server, d.cursor, 10_000);
        for (const op of batch) {
          d.clock.receive(op.hlc);
          if (op.payload.kind === "page.create" && !d.pages.includes(op.entity))
            d.pages.push(op.entity);
          if (op.payload.kind === "block.create" && !d.blocks.some((b) => b.id === op.entity))
            d.blocks.push({ id: op.entity, pageId: op.payload.place.pageId });
        }
        d.cursor = batch.cursor ?? d.cursor;
        break;
      }
      case "replicaPull":
        replicaPull(server, replicas[a.replica] as Replica, a.limit);
        break;
    }
  }

  // Everyone flushes, then every replica catches up — the one that kept pace, the one that pulled
  // in small pages, and a fresh one reading the whole log in one batch.
  for (const d of devices) {
    if (d.outbox.length > 0)
      serverApplyOps(server, d.outbox, { origin: "sync", actor: d.id, deviceId: d.id });
  }
  const fresh = newReplica();
  for (const r of [...replicas, fresh]) replicaPull(server, r, 1_000_000);

  const want = dumpState(server.driver);
  for (const [i, r] of [...replicas, fresh].entries()) {
    expect({ replica: i, state: dumpState(r.driver) }).toEqual({ replica: i, state: want });
  }
  expect(verifyRebuildParity(server.driver).divergences).toEqual([]);
}

describe("server-mediated convergence with lagging clocks (B-587, ADR 026)", () => {
  // 120 s: a hang guard only, same reasoning as core's sync.property.test.ts (B-333).
  it("every pull-only replica and verify's replay match the server, whatever the clocks and interleaving", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 5, maxLength: 80 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 3, maxLength: 3 }),
        (actions, lags) => run(actions, lags),
      ),
      { numRuns: 150 },
    );
  }, 120_000);

  it("the B-587 shape itself: a lagging device's create of a name the server freed", () => {
    // B links "Alpha" (server mints it) and unlinks it (server deletes it); A, 5 s behind and
    // never having pulled, creates "Alpha" — older HLC, later seq.
    run(
      [
        { t: "createPage", dev: 1, name: 1 },
        { t: "createBlock", dev: 1, pick: 0, content: 1 },
        { t: "push", dev: 1 },
        { t: "replicaPull", replica: 0, limit: 50 },
        { t: "tick", ms: 1 },
        { t: "editBlock", dev: 1, pick: 0, content: 0 },
        { t: "push", dev: 1 },
        { t: "createPage", dev: 0, name: 0 },
        { t: "createBlock", dev: 0, pick: 0, content: 0 },
        { t: "push", dev: 0 },
      ],
      [5_000, 0, 0],
    );
  });
});
