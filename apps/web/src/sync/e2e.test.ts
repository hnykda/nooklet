/**
 * The one test that proves the client and server actually agree on the wire (M2's data layer):
 * builds a REAL `@nooklet/server` Hono app in-process (no network, no ports — `app.request(...)`
 * directly, same pattern as `packages/server/src/test-helpers.ts`'s `makeTestServer` /
 * `packages/server/src/sync/sync-test-helpers.ts`'s `makeSyncTestServer`), implements
 * `SyncTransport` by calling that app, and drives the REAL `SyncClient` (`./sync-client.ts`)
 * against it — no fakes anywhere in this file.
 *
 * `@nooklet/server` is a **devDependency only** of `apps/web` (see `package.json`): this test file
 * is its sole consumer. `http-transport.ts`/`sync-client.ts` never import it — the client still
 * knows the server only through `./types.ts`'s wire contract.
 *
 * `sync-test-helpers.ts`/`test-helpers.ts` are internal to `@nooklet/server` (not part of its
 * package `exports`, which only publishes `.`), so the small harness below is built from the
 * package's public exports instead of importing those files directly; `dumpState` is copied
 * verbatim from `sync-test-helpers.ts` per this task's instructions.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema, makeOp, newId, type SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import {
  buildRegistry,
  createApp,
  createServerContext,
  createToken,
  openDb,
  type ServerConfig,
  type ServerContext,
  verifyRebuildParity,
} from "@nooklet/server";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { initClientSchema } from "../db/schema-client.js";
import { SyncClient } from "./sync-client.js";
import type {
  PullResponse,
  PushRequestBody,
  PushResponse,
  SnapshotResponse,
  SyncLiveHandlers,
  SyncTransport,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// Server harness: a real, fully-wired app (op registry + /sync/* + auth), built from
// `@nooklet/server`'s public exports only.
// ---------------------------------------------------------------------------------------------

interface E2eServer {
  app: Hono;
  serverCtx: ServerContext;
  /** A sync-capable (can_sync) bearer token, standing in for one paired device's credential —
   * shared by every replica in these tests, exactly like `sync-test-helpers.ts`'s `syncToken`
   * (a bearer token is not 1:1 with a device; `device_id` is what actually distinguishes them). */
  token: string;
}

function makeE2eServer(): E2eServer {
  const serverCtx = createServerContext(openDb({ path: ":memory:" }));
  const registry = buildRegistry();
  const config: ServerConfig = {
    dataDir: mkdtempSync(join(tmpdir(), "nooklet-web-e2e-")),
    graphId: "default",
    timezone: "UTC",
    port: 0,
    mirror: { enabled: false },
  };
  const app = createApp({ serverCtx, registry, config, version: "0.0.1-e2e-test" });
  const token = createToken(serverCtx.driver, {
    label: "e2e-device",
    scope: "write",
    canSync: true,
  }).token;
  return { app, serverCtx, token };
}

/** The full sync state, in a form two replicas can be `.toEqual()`-compared with — copied from
 * `packages/server/src/sync/sync-test-helpers.ts`'s `dumpState` (not importable: that file is
 * internal test scaffolding, outside `@nooklet/server`'s package `exports`). */
function dumpState(driver: SqlDriver): {
  pages: unknown[];
  blocks: unknown[];
  blockProps: unknown[];
  pageProps: unknown[];
} {
  return {
    pages: driver.all("SELECT * FROM page ORDER BY id"),
    blocks: driver.all("SELECT * FROM block ORDER BY id"),
    blockProps: driver.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: driver.all("SELECT * FROM page_prop ORDER BY page_id, key"),
  };
}

// ---------------------------------------------------------------------------------------------
// SyncTransport implemented over `app.request(...)` directly: same shapes `http-transport.ts`
// sends over real `fetch`/`WebSocket`, but with zero network — proves the two sides' wire
// contract matches without needing a running server or a real socket.
// ---------------------------------------------------------------------------------------------

function makeInProcessTransport(app: Hono, token: string): SyncTransport {
  const authHeaders = { authorization: `Bearer ${token}` };

  async function asJson<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    async push(body: PushRequestBody): Promise<PushResponse> {
      const res = await app.request("/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return asJson<PushResponse>(res, "push");
    },

    async pull(deviceId: string, since: number, limit = 1000): Promise<PullResponse> {
      const params = new URLSearchParams({
        device_id: deviceId,
        since: String(since),
        limit: String(limit),
      });
      const res = await app.request(`/sync/pull?${params}`, { headers: authHeaders });
      return asJson<PullResponse>(res, "pull");
    },

    async snapshot(): Promise<SnapshotResponse> {
      const res = await app.request("/sync/snapshot", { headers: authHeaders });
      return asJson<SnapshotResponse>(res, "snapshot");
    },

    connectLive(_deviceId: string, _handlers: SyncLiveHandlers): () => void {
      // The `/sync/live` WebSocket poke has no `app.request()` equivalent (it's a real socket
      // upgrade) and every test below drives `flush()`/`pull()`/`bootstrap()` explicitly, so
      // there is nothing useful to wire here — see `live.test.ts` (`packages/server/src/sync/`)
      // for the poke itself, which is server-only surface.
      return () => {};
    },
  };
}

/** A fresh client replica: `@nooklet/core`'s state schema plus this app's `pending_op`/
 * `sync_state` tables, exactly like `../db/worker-core.ts`'s `ensureSchema` sets up the real
 * sqlite-wasm/OPFS driver. */
function makeReplicaDriver(): SqlDriver {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  initClientSchema(driver);
  return driver;
}

function makeReplicaClient(
  app: Hono,
  token: string,
  opts: { now?: () => number } = {},
): { driver: SqlDriver; client: SyncClient } {
  const driver = makeReplicaDriver();
  const client = new SyncClient({
    driver,
    transport: makeInProcessTransport(app, token),
    now: opts.now,
  });
  client.init();
  return { driver, client };
}

// ---------------------------------------------------------------------------------------------

describe("sync e2e: real SyncClient <-> real @nooklet/server app, over app.request()", () => {
  let server: E2eServer;

  beforeEach(() => {
    server = makeE2eServer();
  });

  it("applies local ops, flushes to the server, and pulls them into a second replica which converges", async () => {
    const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token);

    const pageId = newId();
    const blockId = newId();
    const childId = newId();

    const pageOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), pageId, {
      kind: "page.create",
      name: "E2E Page",
      journalDay: null,
      createdAt: Date.now(),
    });
    clientA.applyLocal([pageOp]);
    const blockOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), blockId, {
      kind: "block.create",
      place: { pageId, parentId: null, order: "a0" },
      content: "hello from replica A",
      createdAt: Date.now(),
    });
    clientA.applyLocal([blockOp]);
    const childOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), childId, {
      kind: "block.create",
      place: { pageId, parentId: blockId, order: "a0" },
      content: "a child block",
      createdAt: Date.now(),
    });
    clientA.applyLocal([childOp]);
    // A non-reserved key (unlike "marker"/"priority"/"collapsed", which are `block.prop` ops on
    // the wire but land in the `block` table's own dedicated columns, per ops.ts's header comment)
    // so this actually exercises the `block_prop` side table both replicas must converge on.
    const propOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), blockId, {
      kind: "block.prop",
      key: "custom-key",
      value: "custom-value",
    });
    clientA.applyLocal([propOp]);

    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(4);

    await clientA.flush();

    // The push actually landed on the server, not just "flush() didn't throw".
    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(0);
    const serverPage = server.serverCtx.driver.get<{ name: string }>(
      "SELECT name FROM page WHERE id = ?",
      [pageId],
    );
    expect(serverPage).toEqual({ name: "E2E Page" });
    const serverProp = server.serverCtx.driver.get<{ value: string }>(
      "SELECT value FROM block_prop WHERE block_id = ? AND key = 'custom-key'",
      [blockId],
    );
    expect(serverProp?.value).toBe("custom-value");

    // A second, independent replica (its own in-memory SQLite, its own SyncClient, its own
    // device id) pulls the same ops and must converge on identical state.
    const { driver: driverB, client: clientB } = makeReplicaClient(server.app, server.token);
    expect(clientB.getDeviceId()).not.toBe(clientA.getDeviceId());

    await clientB.pull();

    expect(dumpState(driverB)).toEqual(dumpState(server.serverCtx.driver));
    expect(dumpState(driverA)).toEqual(dumpState(server.serverCtx.driver));
  });

  it("pulls a device-far-behind backlog in one call via has_more, not one page per poke", async () => {
    const { client: clientA } = makeReplicaClient(server.app, server.token);

    // Enough pages to force `/sync/pull`'s small test-limit to paginate several times.
    for (let i = 0; i < 5; i++) {
      const id = newId();
      clientA.applyLocal([
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), id, {
          kind: "page.create",
          name: `Backlog ${i}`,
          journalDay: null,
          createdAt: Date.now(),
        }),
      ]);
    }
    await clientA.flush();

    // pullLimit smaller than the backlog forces >1 page: a single pull() call must still drain
    // it all, immediately, via has_more — never left half-caught-up waiting for another poke.
    const driverB = makeReplicaDriver();
    const clientB = new SyncClient({
      driver: driverB,
      transport: makeInProcessTransport(server.app, server.token),
      pullLimit: 2,
    });
    clientB.init();

    await clientB.pull();

    expect(dumpState(driverB)).toEqual(dumpState(server.serverCtx.driver));
    expect(driverB.all("SELECT id FROM page")).toHaveLength(5);
  });

  it("bootstraps a fresh replica from /sync/snapshot and matches server state exactly", async () => {
    const { client: clientA } = makeReplicaClient(server.app, server.token);
    const pageId = newId();
    const blockId = newId();
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), pageId, {
        kind: "page.create",
        name: "Bootstrap Source",
        journalDay: null,
        createdAt: Date.now(),
      }),
    ]);
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "seed content",
        createdAt: Date.now(),
      }),
    ]);
    await clientA.flush();

    // A brand-new replica (never pushed/pulled anything) bootstraps from the snapshot alone.
    const { driver: driverC, client: clientC } = makeReplicaClient(server.app, server.token);
    expect(clientC.isBootstrapped()).toBe(false);

    await clientC.bootstrap();

    expect(clientC.isBootstrapped()).toBe(true);
    expect(dumpState(driverC)).toEqual(dumpState(server.serverCtx.driver));
  });

  /**
   * B-660. `/sync/snapshot` lists blocks in the server table's rowid order, which is creation
   * order, so a block moved under one created AFTER it arrives before its parent. The replica
   * enforces `block.parent_id REFERENCES block(id)` immediately, the insert failed with
   * SQLITE_CONSTRAINT_FOREIGNKEY, and the whole bootstrap rolled back. The app hid that by pulling
   * the op log from 0 instead, which only works while the server still has every op: after
   * `nooklet gc` trims the log, the fresh device silently came up without the trimmed rows.
   */
  describe("a block moved under a block created after it (B-660)", () => {
    function seedMovedUnderNewer() {
      const { client: clientA } = makeReplicaClient(server.app, server.token);
      const pageId = newId();
      const older = newId();
      const newer = newId();
      clientA.applyLocal([
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), pageId, {
          kind: "page.create",
          name: "Moved Under Newer",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), older, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "older",
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), newer, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a1" },
          content: "newer",
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), older, {
          kind: "block.place",
          place: { pageId, parentId: newer, order: "a0" },
        }),
      ]);
      return { clientA, older, newer };
    }

    it("bootstraps a fresh replica whose snapshot lists the child before its parent", async () => {
      const { clientA, older, newer } = seedMovedUnderNewer();
      await clientA.flush();
      // The precondition this test is about: the snapshot really does put the child first.
      const snap = (await makeInProcessTransport(server.app, server.token).snapshot()).blocks;
      expect(snap.findIndex((b) => b.id === older)).toBeLessThan(
        snap.findIndex((b) => b.id === newer),
      );

      const { driver: driverC, client: clientC } = makeReplicaClient(server.app, server.token);
      await clientC.bootstrap();

      expect(clientC.isBootstrapped()).toBe(true);
      expect(dumpState(driverC)).toEqual(dumpState(server.serverCtx.driver));
    });

    it("a fresh replica gets every row even after the server's op log was trimmed", async () => {
      const { clientA } = seedMovedUnderNewer();
      await clientA.flush();
      // What `nooklet gc` does once every live device has acked past these ops (`gc.ts`).
      server.serverCtx.driver.run("DELETE FROM op");

      // The app's own start-up sequence (`worker-core.ts#start`): bootstrap, tolerate a
      // failure, then pull.
      const { driver: driverC, client: clientC } = makeReplicaClient(server.app, server.token);
      await clientC.bootstrap().catch(() => {});
      await clientC.pull();

      expect(dumpState(driverC)).toEqual(dumpState(server.serverCtx.driver));
    });

    it("re-bootstrapping over a replica that already holds the rows replaces them cleanly", async () => {
      const { clientA } = seedMovedUnderNewer();
      await clientA.flush();
      const { driver: driverC, client: clientC } = makeReplicaClient(server.app, server.token);
      await clientC.bootstrap();
      // `INSERT OR REPLACE` deletes and re-inserts a parent its children still point at.
      await clientC.bootstrap();

      expect(dumpState(driverC)).toEqual(dumpState(server.serverCtx.driver));
    });
  });

  /**
   * ADR 024's two-device race. Device B writes `[[Race Page]]`, so the server creates that page;
   * device A, which has not heard of it, creates "Race Page" itself and types into it. Whichever
   * A does first after that — push (the server refuses A's page and names its own) or pull (the
   * server's page arrives while A's holds the name) — every replica must end with ONE page under
   * the name, holding A's blocks, and the server's op log must still replay exactly.
   */
  for (const order of ["push first", "pull first"] as const) {
    it(`a page created offline under a name the server already made from a reference converges, ${order}`, async () => {
      const { driver: driverB, client: clientB } = makeReplicaClient(server.app, server.token);
      const home = newId();
      clientB.applyLocal([
        makeOp(clientB.nextHlc(), clientB.getDeviceId(), home, {
          kind: "page.create",
          name: "Home B",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(clientB.nextHlc(), clientB.getDeviceId(), newId(), {
          kind: "block.create",
          place: { pageId: home, parentId: null, order: "a0" },
          content: "see [[Race Page]]",
          createdAt: Date.now(),
        }),
      ]);

      // A, "offline": its ops are minted before B's push reaches the server, so they are OLDER.
      const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token);
      const refused = newId();
      const parent = newId();
      const child = newId();
      clientA.applyLocal([
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), refused, {
          kind: "page.create",
          name: "Race Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), parent, {
          kind: "block.create",
          place: { pageId: refused, parentId: null, order: "a0" },
          content: "typed offline",
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), child, {
          kind: "block.create",
          place: { pageId: refused, parentId: parent, order: "a0" },
          content: "and a child",
          createdAt: Date.now(),
        }),
      ]);
      clientA.applyLocal([
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), parent, {
          kind: "block.text",
          content: "typed offline, then edited",
        }),
      ]);

      await clientB.flush();
      const serverPage = server.serverCtx.driver.get<{ id: string }>(
        "SELECT id FROM page WHERE key = 'race page' AND deleted_at IS NULL",
      );
      expect(serverPage).toBeDefined();
      const winner = serverPage?.id as string;

      if (order === "push first") {
        await clientA.flush(); // refused; A moves onto the server's page and re-queues its blocks
        await clientA.flush(); // the re-sent blocks
        await clientA.pull();
      } else {
        await clientA.pull(); // the server's page arrives while A's still holds the name
        await clientA.flush();
        await clientA.pull();
      }
      await clientB.pull();

      const s = server.serverCtx.driver;
      expect(s.all("SELECT id FROM page WHERE key = 'race page' AND deleted_at IS NULL")).toEqual([
        { id: winner },
      ]);
      expect(s.get("SELECT id FROM page WHERE id = ?", [refused])).toBeUndefined();
      expect(
        s.all<{ id: string; page_id: string; parent_id: string | null; content: string }>(
          "SELECT id, page_id, parent_id, content FROM block WHERE page_id = ? ORDER BY content DESC",
          [winner],
        ),
      ).toEqual([
        { id: parent, page_id: winner, parent_id: null, content: "typed offline, then edited" },
        { id: child, page_id: winner, parent_id: parent, content: "and a child" },
      ]);
      expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(0);
      expect(dumpState(driverA)).toEqual(dumpState(s));
      expect(dumpState(driverB)).toEqual(dumpState(s));
      expect(verifyRebuildParity(s).divergences).toEqual([]);
    });
  }

  /**
   * The other side of the race above: the name's earlier page was created AND deleted on the server
   * (a link typed and removed on another device — ADR 024's short-lived pages), so this device's
   * own page of that name is the real one. Pulling the old page's create must not move this
   * device's content onto the tombstone, whichever of push and pull comes first.
   */
  for (const order of ["push first", "pull first"] as const) {
    it(`a page of a name whose earlier page the server deleted stays this device's page, ${order}`, async () => {
      const { client: clientB } = makeReplicaClient(server.app, server.token);
      const home = newId();
      const line = newId();
      clientB.applyLocal([
        makeOp(clientB.nextHlc(), clientB.getDeviceId(), home, {
          kind: "page.create",
          name: "Home B",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(clientB.nextHlc(), clientB.getDeviceId(), line, {
          kind: "block.create",
          place: { pageId: home, parentId: null, order: "a0" },
          content: "[[Ghost Name]]",
          createdAt: Date.now(),
        }),
      ]);
      await clientB.flush();
      clientB.applyLocal([
        makeOp(clientB.nextHlc(), clientB.getDeviceId(), line, {
          kind: "block.text",
          content: "no link any more",
        }),
      ]);
      await clientB.flush();
      const s = server.serverCtx.driver;
      expect(s.all("SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL")).toEqual(
        [],
      );
      expect(s.all("SELECT id FROM page WHERE key = 'ghost name'")).toHaveLength(1);

      const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token);
      const mine = newId();
      const block = newId();
      clientA.applyLocal([
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), mine, {
          kind: "page.create",
          name: "Ghost Name",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(clientA.nextHlc(), clientA.getDeviceId(), block, {
          kind: "block.create",
          place: { pageId: mine, parentId: null, order: "a0" },
          content: "mine",
          createdAt: Date.now(),
        }),
      ]);
      if (order === "push first") {
        await clientA.flush();
        await clientA.pull();
      } else {
        await clientA.pull();
        await clientA.flush();
        await clientA.pull();
      }

      expect(s.all("SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL")).toEqual([
        { id: mine },
      ]);
      expect(s.get<{ page_id: string }>("SELECT page_id FROM block WHERE id = ?", [block])).toEqual(
        { page_id: mine },
      );
      // Everything live is identical. The old page's TOMBSTONE is not in A's replica: its create
      // met A's page holding the name and A refused it (B-443, open — why the server never revives
      // an unclaimed tombstone). Compared without tombstoned pages for that reason only.
      const live = (d: SqlDriver) => ({
        ...dumpState(d),
        pages: d.all("SELECT * FROM page WHERE deleted_at IS NULL ORDER BY id"),
      });
      expect(live(driverA)).toEqual(live(s));
      expect(verifyRebuildParity(s).divergences).toEqual([]);
    });
  }

  /**
   * B-587, made deterministic: the server applies device A's `page.create` of "Ghost Name" AFTER
   * its own `page.delete` of the old page of that name (seq order), but A's op carries the SMALLER
   * HLC — A's clock runs 5 s behind and A had not pulled yet (ADR 003 rejects only clocks that
   * run ahead). Every replica must end where the server is, however it learns the ops: B is live
   * and pulls them one push at a time, C bootstrapped before and pulls the delete and A's ops in
   * one batch, D pulls the whole log in one batch, E bootstraps afterwards. Before ADR 026 a
   * one-batch pull re-sorted by HLC: C met A's create while the old page was still live and lost
   * A's page and block; D applied A's create before the old page's and lost that tombstone.
   */
  it("a page created under a name the server freed, with an HLC older than the freeing op, converges on every replica (B-587)", async () => {
    const s = server.serverCtx.driver;
    const { driver: driverB, client: clientB } = makeReplicaClient(server.app, server.token);
    const home = newId();
    const line = newId();
    clientB.applyLocal([
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), home, {
        kind: "page.create",
        name: "Home B",
        journalDay: null,
        createdAt: Date.now(),
      }),
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), line, {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "a0" },
        content: "[[Ghost Name]]",
        createdAt: Date.now(),
      }),
    ]);
    await clientB.flush();

    const { driver: driverC, client: clientC } = makeReplicaClient(server.app, server.token);
    await clientC.bootstrap();
    expect(
      driverC.all("SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL"),
    ).toHaveLength(1);
    const { driver: driverD, client: clientD } = makeReplicaClient(server.app, server.token);

    clientB.applyLocal([
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), line, {
        kind: "block.text",
        content: "no link any more",
      }),
    ]);
    await clientB.flush();
    const freed = s.get<{ hlc: string }>(
      "SELECT hlc FROM op WHERE kind = 'page.delete' AND device_id = 'refpages'",
    );
    expect(freed).toBeDefined();

    const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token, {
      now: () => Date.now() - 5_000,
    });
    const mine = newId();
    const block = newId();
    const createOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), mine, {
      kind: "page.create",
      name: "Ghost Name",
      journalDay: null,
      createdAt: Date.now(),
    });
    clientA.applyLocal([
      createOp,
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), block, {
        kind: "block.create",
        place: { pageId: mine, parentId: null, order: "a0" },
        content: "mine",
        createdAt: Date.now(),
      }),
    ]);
    // The B-587 shape, asserted rather than hoped for: older HLC, later seq.
    expect(createOp.hlc < (freed?.hlc as string)).toBe(true);
    await clientA.flush();
    expect(s.all("SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL")).toEqual([
      { id: mine },
    ]);

    await clientA.pull();
    await clientB.pull();
    await clientC.pull();
    await clientD.pull();
    const { driver: driverE, client: clientE } = makeReplicaClient(server.app, server.token);
    await clientE.bootstrap();

    const liveOnly = (d: SqlDriver) => ({
      ...dumpState(d),
      pages: d.all("SELECT * FROM page WHERE deleted_at IS NULL ORDER BY id"),
    });
    // A never holds the old page's tombstone: its create met A's live page (B-443, open), so A is
    // compared on live rows only; every other replica byte for byte.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const diverged = [
      ...(same(liveOnly(driverA), liveOnly(s)) ? [] : ["A"]),
      ...(
        [
          ["B", driverB],
          ["C", driverC],
          ["D", driverD],
          ["E", driverE],
        ] as const
      )
        .filter(([, d]) => !same(dumpState(d), dumpState(s)))
        .map(([name]) => name),
    ];
    expect(diverged).toEqual([]);
    expect(driverD.get("SELECT page_id FROM block WHERE id = ?", [block])).toEqual({
      page_id: mine,
    });
    expect(verifyRebuildParity(s).divergences).toEqual([]);
  });

  /**
   * B-445: device A, offline, types into a page a link made (ADR 024) while device B edits that
   * link away, so the server deletes the page as unclaimed junk. When A comes back, what it typed
   * must still be on a live page — on every replica — not on a tombstone the trash hides.
   */
  it("writing that reaches a linked page after its link was removed keeps the page, on every replica", async () => {
    const { driver: driverB, client: clientB } = makeReplicaClient(server.app, server.token);
    const home = newId();
    const link = newId();
    clientB.applyLocal([
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), home, {
        kind: "page.create",
        name: "Home",
        journalDay: null,
        createdAt: Date.now(),
      }),
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), link, {
        kind: "block.create",
        place: { pageId: home, parentId: null, order: "a0" },
        content: "see [[Offline Notes]]",
        createdAt: Date.now(),
      }),
    ]);
    await clientB.flush();

    const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token);
    await clientA.pull();
    const notes = driverA.get<{ id: string }>(
      "SELECT id FROM page WHERE key = 'offline notes' AND deleted_at IS NULL",
    )?.id as string;
    expect(notes).toBeDefined();

    // A goes offline and types into the empty page.
    const typed = newId();
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), typed, {
        kind: "block.create",
        place: { pageId: notes, parentId: null, order: "a0" },
        content: "written while offline",
        createdAt: Date.now(),
      }),
    ]);
    // Meanwhile B edits the link away: the server removes the page it made.
    clientB.applyLocal([
      makeOp(clientB.nextHlc(), clientB.getDeviceId(), link, {
        kind: "block.text",
        content: "see nothing",
      }),
    ]);
    await clientB.flush();
    const s = server.serverCtx.driver;
    expect(s.get("SELECT deleted_at FROM page WHERE id = ?", [notes])).not.toEqual({
      deleted_at: null,
    });

    await clientA.flush();
    await clientA.pull();
    await clientB.pull();

    expect(
      s.get("SELECT id, deleted_at FROM page WHERE key = 'offline notes' AND deleted_at IS NULL"),
    ).toEqual({
      id: notes,
      deleted_at: null,
    });
    expect(s.get("SELECT page_id, content FROM block WHERE id = ?", [typed])).toEqual({
      page_id: notes,
      content: "written while offline",
    });
    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(0);
    expect(dumpState(driverA)).toEqual(dumpState(s));
    expect(dumpState(driverB)).toEqual(dumpState(s));
    expect(verifyRebuildParity(s).divergences).toEqual([]);
  });

  it("a rejected cycle-creating block.place corrects locally: the client applies the server's corrective op and converges", async () => {
    const { driver: driverA, client: clientA } = makeReplicaClient(server.app, server.token);

    const pageId = newId();
    const parentId = newId();
    const childId = newId();
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), pageId, {
        kind: "page.create",
        name: "Cycle E2E",
        journalDay: null,
        createdAt: Date.now(),
      }),
    ]);
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), parentId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "parent",
        createdAt: Date.now(),
      }),
    ]);
    clientA.applyLocal([
      makeOp(clientA.nextHlc(), clientA.getDeviceId(), childId, {
        kind: "block.create",
        place: { pageId, parentId, order: "a0" },
        content: "child",
        createdAt: Date.now(),
      }),
    ]);
    await clientA.flush();
    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(0);

    // Move `parent` to be a child of its own child -> a cycle. `@nooklet/core`'s `applyOps` (the
    // same code both client and server call) rejects this locally too, so local state is
    // unchanged; the op is still queued and pushed (ADR 003: the server is the sole structural
    // arbiter, per `SyncClient.applyLocal`'s doc comment).
    const cycleOp = makeOp(clientA.nextHlc(), clientA.getDeviceId(), parentId, {
      kind: "block.place",
      place: { pageId, parentId: childId, order: "z0" },
    });
    const localResult = clientA.applyLocal([cycleOp]);
    expect(localResult.rejected).toBe(1);
    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(1);

    await clientA.flush();

    // The rejected op is drained from the outbox and the server's corrective op (restoring
    // `parent`'s prior place) has been applied locally.
    expect(driverA.all("SELECT * FROM pending_op")).toHaveLength(0);
    const parentRow = driverA.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [parentId],
    );
    expect(parentRow?.parent_id).toBeNull();

    // Both the pusher and the server converge...
    expect(dumpState(driverA)).toEqual(dumpState(server.serverCtx.driver));

    // ...and so does a second replica that only ever pulls, never having seen the rejected op at
    // all (rule: a rejected op never leaves the `op` table's `status` column) — it should see
    // exactly the applied ops plus the correction, and land in the same state.
    const { driver: driverB, client: clientB } = makeReplicaClient(server.app, server.token);
    await clientB.pull();
    expect(dumpState(driverB)).toEqual(dumpState(server.serverCtx.driver));
    const parentRowB = driverB.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [parentId],
    );
    expect(parentRowB?.parent_id).toBeNull();
  });

  /**
   * B-642 / ADR 027, the owner's report: one block edited on two devices, one of them offline,
   * both replacing the whole text — a true conflict. The losing text must end as its own block
   * right after the winner (marked `sync-conflict`), on every replica, with no `conflict_copy`
   * chip left behind.
   */
  describe("a same-block conflict leaves the losing text as a block after the winner (B-642)", () => {
    function livePage(driver: SqlDriver, pageId: string) {
      return driver
        .all<{ id: string; content: string }>(
          "SELECT id, content FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY order_key, id",
          [pageId],
        )
        .map((b) => ({
          content: b.content,
          props: Object.fromEntries(
            driver
              .all<{ key: string; value: string | null }>(
                "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
                [b.id],
              )
              .map((p) => [p.key, p.value]),
          ),
        }));
    }

    async function seed(): Promise<{
      a: ReturnType<typeof makeReplicaClient>;
      b: ReturnType<typeof makeReplicaClient>;
      pageId: string;
      blockId: string;
    }> {
      const a = makeReplicaClient(server.app, server.token);
      const pageId = newId();
      const blockId = newId();
      a.client.applyLocal([
        makeOp(a.client.nextHlc(), a.client.getDeviceId(), pageId, {
          kind: "page.create",
          name: "Conflict Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(a.client.nextHlc(), a.client.getDeviceId(), blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "Something",
          createdAt: Date.now(),
        }),
        makeOp(a.client.nextHlc(), a.client.getDeviceId(), newId(), {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a1" },
          content: "the next block",
          createdAt: Date.now(),
        }),
      ]);
      await a.client.flush();
      // B's clock runs a second ahead, so B's edit is the newer one and wins LWW. With both on
      // the wall clock the two edits often landed in one millisecond and the HLC tie went to
      // whichever random device id sorted higher: 6 runs in 20 failed with the texts swapped.
      const b = makeReplicaClient(server.app, server.token, { now: () => Date.now() + 1000 });
      await b.client.pull();
      return { a, b, pageId, blockId };
    }

    const want = [
      { content: "Nothing", props: {} },
      { content: "There is this", props: { "sync-conflict": "true" } },
      { content: "the next block", props: {} },
    ];

    it("one device offline: it comes back, notices, and both devices read both texts", async () => {
      const { a, b, pageId, blockId } = await seed();

      // A is offline and rewrites the block; B, online, rewrites it later (so B's text wins LWW).
      a.client.applyLocal([
        makeOp(a.client.nextHlc(), a.client.getDeviceId(), blockId, {
          kind: "block.text",
          content: "There is this",
        }),
      ]);
      b.client.applyLocal([
        makeOp(b.client.nextHlc(), b.client.getDeviceId(), blockId, {
          kind: "block.text",
          content: "Nothing",
        }),
      ]);
      await b.client.flush();

      // A comes back: pull first (as `connectLive`'s onOpen does), then its outbox.
      await a.client.pull();
      await a.client.flush();
      await a.client.pull();
      await b.client.pull();

      const s = server.serverCtx.driver;
      expect(livePage(s, pageId)).toEqual(want);
      expect(livePage(a.driver, pageId)).toEqual(want);
      expect(livePage(b.driver, pageId)).toEqual(want);
      expect(dumpState(a.driver)).toEqual(dumpState(s));
      expect(dumpState(b.driver)).toEqual(dumpState(s));
      expect(verifyRebuildParity(s).divergences).toEqual([]);
    });

    it("both devices notice the same conflict: still exactly one copy", async () => {
      const { a, b, pageId, blockId } = await seed();

      // A's push reaches the server but its response is lost, so A's edit stays pending — A will
      // treat B's later edit as a conflict too, exactly as B does.
      const real = makeInProcessTransport(server.app, server.token);
      const lossy = new SyncClient({
        driver: a.driver,
        transport: {
          ...real,
          async push(body) {
            await real.push(body);
            throw new Error("response lost");
          },
        },
      });
      lossy.init();

      lossy.applyLocal([
        makeOp(lossy.nextHlc(), lossy.getDeviceId(), blockId, {
          kind: "block.text",
          content: "There is this",
        }),
      ]);
      b.client.applyLocal([
        makeOp(b.client.nextHlc(), b.client.getDeviceId(), blockId, {
          kind: "block.text",
          content: "Nothing",
        }),
      ]);
      await lossy.flush();
      expect(a.driver.all("SELECT id FROM pending_op WHERE kind = 'block.text'")).toHaveLength(1);

      // B pulls A's edit while its own is pending: conflict, reported.
      await b.client.pull();
      await b.client.flush();
      // A pulls its own edit and then B's. Since B-652 a client takes an op that comes after its
      // own in the server's log as written by a device that may have seen its own — the device
      // with the later op (B) is the one that reports — so A does not report it again...
      await lossy.pull();
      expect(a.driver.all("SELECT 1 FROM pending_op WHERE kind = 'block.prop'")).toEqual([]);
      // ...but a client built before B-652 did, with a newer clock: same report, A's side.
      lossy.applyLocal([
        makeOp(lossy.nextHlc(), lossy.getDeviceId(), blockId, {
          kind: "block.prop",
          key: "conflict_copy",
          value: "There is this",
        }),
      ]);
      const aReal = new SyncClient({ driver: a.driver, transport: real });
      aReal.init();
      await aReal.flush();
      await aReal.pull();
      await b.client.pull();

      const s = server.serverCtx.driver;
      expect(livePage(s, pageId)).toEqual(want);
      expect(dumpState(a.driver)).toEqual(dumpState(s));
      expect(dumpState(b.driver)).toEqual(dumpState(s));
      expect(verifyRebuildParity(s).divergences).toEqual([]);
    });
  });

  /**
   * B-652: conflict detection used to need this device's own `block.text` still in `pending_op`
   * when the other device's op was pulled. `worker-core.ts` runs push and pull concurrently on
   * `online`/`resume`/`visible` (and `connectLive`'s onOpen does too), so when the push response
   * was applied first the row was gone, the pulled op met no local edit, and LWW dropped one text
   * with no copy. The transport below holds each response until the test releases it, so the
   * order is exact; the server handles the requests in the order they were sent.
   */
  describe("a same-block conflict is kept whichever response a reconnecting device gets first (B-652)", () => {
    type Kind = "push" | "pull";
    type Order = readonly [Kind, Kind];
    interface Device {
      name: string;
      driver: SqlDriver;
      client: SyncClient;
      /** While `on`, push/pull responses wait in `held` for the test to release them. */
      gate: { on: boolean; held: Array<{ what: Kind; release: () => void }> };
    }

    function makeDevice(name: string, offsetMs: number, clock: () => number = Date.now): Device {
      const real = makeInProcessTransport(server.app, server.token);
      const gate: Device["gate"] = { on: false, held: [] };
      // One request at a time reaches the server, in the order the client sent them.
      let serverQueue: Promise<unknown> = Promise.resolve();
      function wrap<T>(what: Kind, call: () => Promise<T>): Promise<T> {
        const done = serverQueue.then(call);
        serverQueue = done.catch(() => {});
        if (!gate.on) return done;
        return new Promise<T>((resolve, reject) => {
          const hold = () =>
            gate.held.push({ what, release: () => void done.then(resolve, reject) });
          void done.then(hold, hold);
        });
      }
      const driver = makeReplicaDriver();
      const client = new SyncClient({
        driver,
        // A per-device clock offset decides who wins LWW, independent of test timing.
        now: () => clock() + offsetMs,
        transport: {
          ...real,
          push: (body) => wrap("push", () => real.push(body)),
          pull: (d, since, limit) => wrap("pull", () => real.pull(d, since, limit)),
        },
      });
      // A fixed device id (`init` keeps one it finds): HLC ties break on it, so a random one
      // would make the random schedules below not replay.
      driver.run("INSERT INTO sync_state(key, value) VALUES ('device_id', ?)", [
        `d${name.toLowerCase()}`.padStart(8, "0"),
      ]);
      client.init();
      // No debounced background push: it fired whenever a run happened to last 300 ms, at a
      // different point each time. The tests push explicitly (`flush`, `reconnect`), which is
      // what that timer does.
      client.schedulePush = () => {};
      return { name, driver, client, gate };
    }

    /** What `notifyLifecycle("online")` does — push and pull at once — with the server handling
     * `sent[0]` then `sent[1]`, and the device applying the responses in `applied` order. */
    async function reconnect(d: Device, sent: Order, applied: Order): Promise<void> {
      d.gate.on = true;
      // An empty outbox sends no push at all.
      const requests = sent.filter((w) => w === "pull" || d.client.getStatus().pendingCount > 0);
      const running = new Map<Kind, Promise<void>>();
      for (const what of sent)
        running.set(what, what === "push" ? d.client.flush() : d.client.pull());
      for (let i = 0; i < 100 && d.gate.held.length < requests.length; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(d.gate.held.map((h) => h.what)).toEqual(requests);
      d.gate.on = false;
      for (const what of applied) {
        d.gate.held.find((h) => h.what === what)?.release();
        await running.get(what);
      }
      d.gate.held = [];
    }

    /** Everyone pushes and pulls until nothing moves (merge ops, conflict reports, the server's
     * copies): a round in which no device had anything to push and the log did not grow. */
    async function settle(devices: readonly Device[]): Promise<void> {
      const head = () =>
        server.serverCtx.driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")
          ?.n ?? 0;
      for (let round = 0; round < 10; round++) {
        const before = head();
        let pushed = false;
        for (const d of devices) {
          pushed ||= d.client.getStatus().pendingCount > 0;
          await d.client.flush();
          await d.client.pull();
        }
        const queued = devices.some((d) => d.client.getStatus().pendingCount > 0);
        if (!pushed && !queued && head() === before) return;
      }
      throw new Error("sync did not settle in 10 rounds");
    }

    function contents(driver: SqlDriver, pageId: string): string[] {
      return driver
        .all<{ content: string }>(
          "SELECT content FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY content",
          [pageId],
        )
        .map((b) => b.content);
    }

    async function seed(devices: readonly Device[]): Promise<{ pageId: string; blockId: string }> {
      const first = devices[0];
      if (!first) throw new Error("no devices");
      const pageId = newId();
      const blockId = newId();
      const c = first.client;
      c.applyLocal([
        makeOp(c.nextHlc(), c.getDeviceId(), pageId, {
          kind: "page.create",
          name: "Race Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(c.nextHlc(), c.getDeviceId(), blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "Something",
          createdAt: Date.now(),
        }),
      ]);
      await c.flush();
      for (const d of devices) await d.client.pull();
      return { pageId, blockId };
    }

    function edit(d: Device, blockId: string, content: string): void {
      const c = d.client;
      c.applyLocal([
        makeOp(c.nextHlc(), c.getDeviceId(), blockId, { kind: "block.text", content }),
      ]);
    }

    function expectAllKept(devices: readonly Device[], pageId: string, texts: string[]): void {
      const s = server.serverCtx.driver;
      expect(contents(s, pageId)).toEqual([...texts].sort());
      expect(
        s.all("SELECT 1 FROM block_prop WHERE key = 'conflict_copy' AND value IS NOT NULL"),
      ).toEqual([]);
      for (const d of devices) expect(dumpState(d.driver), d.name).toEqual(dumpState(s));
      expect(verifyRebuildParity(s).divergences).toEqual([]);
    }

    const PUSH_FIRST: Order = ["push", "pull"];
    const PULL_FIRST: Order = ["pull", "push"];

    for (const sent of [PUSH_FIRST, PULL_FIRST]) {
      for (const applied of [PUSH_FIRST, PULL_FIRST]) {
        for (const aWins of [false, true]) {
          it(`one device offline; server takes the ${sent[0]} first, the device applies the ${applied[0]} response first; its text ${aWins ? "wins" : "loses"}`, async () => {
            // A's clock is ahead when its text should win LWW, behind when it should lose.
            const a = makeDevice("A", aWins ? 2000 : 0);
            const b = makeDevice("B", 1000);
            const { pageId, blockId } = await seed([a, b]);

            edit(a, blockId, "There is this"); // A is offline
            edit(b, blockId, "Nothing");
            await b.client.flush();
            await b.client.pull();

            await reconnect(a, sent, applied);
            await settle([a, b]);
            expectAllKept([a, b], pageId, ["Nothing", "There is this"]);
          });
        }
      }
    }

    for (const firstBack of ["A", "B"]) {
      it(`both devices offline, each reconnects push response first, ${firstBack} first`, async () => {
        const a = makeDevice("A", 0);
        const b = makeDevice("B", 1000);
        const { pageId, blockId } = await seed([a, b]);
        edit(a, blockId, "There is this");
        edit(b, blockId, "Nothing");
        const [x, y] = firstBack === "A" ? [a, b] : [b, a];
        await reconnect(x, PUSH_FIRST, PUSH_FIRST);
        await reconnect(y, PUSH_FIRST, PUSH_FIRST);
        await settle([a, b]);
        expectAllKept([a, b], pageId, ["Nothing", "There is this"]);
      });
    }

    it("both online: each pushes before it has pulled the other's edit", async () => {
      const a = makeDevice("A", 0);
      const b = makeDevice("B", 1000);
      const { pageId, blockId } = await seed([a, b]);
      edit(a, blockId, "There is this");
      edit(b, blockId, "Nothing");
      await a.client.flush();
      await b.client.flush();
      await a.client.pull();
      await b.client.pull();
      await settle([a, b]);
      expectAllKept([a, b], pageId, ["Nothing", "There is this"]);
    });

    for (const order of [
      ["A", "B", "C"],
      ["C", "B", "A"],
      ["B", "C", "A"],
      ["A", "C", "B"],
    ]) {
      it(`three devices offline, reconnecting ${order.join(", ")} push response first: all three texts survive`, async () => {
        const devs = new Map(
          (["A", "B", "C"] as const).map((n, i) => [n as string, makeDevice(n, i * 1000)]),
        );
        const all = [...devs.values()];
        const { pageId, blockId } = await seed(all);
        for (const [n, text] of [
          ["A", "Alpha"],
          ["B", "Beta"],
          ["C", "Gamma"],
        ] as const) {
          edit(devs.get(n) as Device, blockId, text);
        }
        for (const n of order) await reconnect(devs.get(n) as Device, PUSH_FIRST, PUSH_FIRST);
        await settle(all);
        expectAllKept(all, pageId, ["Alpha", "Beta", "Gamma"]);
      });
    }

    /** Text edits that touch different words merge cleanly; the block holds every one of them. */
    async function seedText(devices: readonly Device[], text: string) {
      const seeded = await seed(devices);
      const first = devices[0] as Device;
      edit(first, seeded.blockId, text);
      await first.client.flush();
      for (const d of devices) await d.client.pull();
      return seeded;
    }

    for (const order of [
      ["A", "B", "C"],
      ["C", "B", "A"],
      ["B", "A", "C"],
    ]) {
      it(`three devices edit different words offline, reconnecting ${order.join(", ")} push response first: one text with all three edits`, async () => {
        const devs = new Map(
          (["A", "B", "C"] as const).map((n, i) => [n as string, makeDevice(n, i * 1000)]),
        );
        const all = [...devs.values()];
        const { pageId, blockId } = await seedText(all, "one two three");
        edit(devs.get("A") as Device, blockId, "ONE two three");
        edit(devs.get("B") as Device, blockId, "one TWO three");
        edit(devs.get("C") as Device, blockId, "one two THREE");
        for (const n of order) await reconnect(devs.get(n) as Device, PUSH_FIRST, PUSH_FIRST);
        await settle(all);
        expectAllKept(all, pageId, ["ONE TWO THREE"]);
      });
    }

    it("two local edits of one block before the other device's edit arrives: the merge keeps the first one too", async () => {
      // The merge base is the text before this device's FIRST unseen edit. Merging against the
      // second edit's base (the first edit's text) made the other device's text look like it had
      // reverted "ONE", and the merge quietly put "one" back.
      const a = makeDevice("A", 0);
      const b = makeDevice("B", 1000);
      const { pageId, blockId } = await seedText([a, b], "one two three");
      edit(a, blockId, "ONE two three");
      edit(a, blockId, "ONE two THREE");
      edit(b, blockId, "one TWO three");
      await b.client.flush();
      await a.client.pull();
      await settle([a, b]);
      expectAllKept([a, b], pageId, ["ONE TWO THREE"]);
    });

    /**
     * Random schedules, seeded (this package has no fast-check; a failing seed is named in the
     * assertion and replays exactly). Every device edits the block — once or twice — before any
     * other device's edit has reached it, then they push, pull and reconnect in random order with
     * random response order, then sync until nothing moves. Clock offsets are random, so any
     * device may win LWW and any of their ops may be a noop on the server.
     *
     * - "conflict": each edit replaces the whole text. Each device's last text must be on the page
     *   (as the block, or as a conflict copy next to it).
     * - "merge": device i only ever changes word i. The block must end with every device's last
     *   word, in one text, and no conflict copy.
     *
     * Either way every replica must equal the server, and `verify` must be clean. 120 seeds per
     * mode by default; `B652_RUNS=5000` for a long run (passed, 2026-10-04).
     */
    for (const mode of ["conflict", "merge"] as const) {
      it(`random reconnect schedules (${mode}): no device's edit is lost, every replica converges`, async () => {
        function rng(seed: number): () => number {
          let a = seed >>> 0;
          return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        }
        const orders: Order[] = [PUSH_FIRST, PULL_FIRST];
        const runs = Number(process.env.B652_RUNS ?? 120);
        for (let run = 1; run <= runs; run++) {
          const r = rng(run);
          const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
          server = makeE2eServer();
          // A virtual clock, one millisecond per reading, so the HLCs — and with them every LWW
          // decision — depend on the seed alone and a failing seed replays exactly.
          let t = Date.now();
          const clock = () => t++;
          const n = 2 + Math.floor(r() * 2);
          const devices = Array.from({ length: n }, (_, i) =>
            makeDevice(String.fromCharCode(65 + i), Math.floor(r() * 3000), clock),
          );
          const words = ["w0", "w1", "w2"];
          const { pageId, blockId } =
            mode === "merge" ? await seedText(devices, words.join(" ")) : await seed(devices);
          const last = new Map<string, string>();
          devices.forEach((d, i) => {
            const edits = 1 + Math.floor(r() * 2);
            for (let e = 0; e < edits; e++) {
              const mine = `${d.name}${e}`;
              const text =
                mode === "merge"
                  ? words.map((w, j) => (j === i ? mine : w)).join(" ")
                  : `text-${mine}`;
              edit(d, blockId, text);
              last.set(d.name, mine);
            }
          });
          const steps = 3 + Math.floor(r() * 8);
          for (let s = 0; s < steps; s++) {
            const d = pick(devices);
            const step = pick(["flush", "pull", "reconnect"] as const);
            if (step === "flush") await d.client.flush();
            else if (step === "pull") await d.client.pull();
            else await reconnect(d, pick(orders), pick(orders));
          }
          await settle(devices);

          const s = server.serverCtx.driver;
          const live = contents(s, pageId);
          const at = `${mode} seed ${run}`;
          if (mode === "merge") {
            const want = words.map((w, j) => last.get(String.fromCharCode(65 + j)) ?? w).join(" ");
            // One block holding every device's last word — no conflict copy either: the edits
            // touch different words, so a copy here would mean a merge picked the wrong ancestor
            // (`mergeBase` in sync-client.ts; 0 copies in 2000 seeds per mode once own and
            // third-device texts were candidates, 477 before).
            expect(live, at).toEqual([want]);
          } else {
            for (const text of last.values()) expect(live, at).toContain(`text-${text}`);
          }
          for (const d of devices) {
            expect(dumpState(d.driver), `${at}, ${d.name}`).toEqual(dumpState(s));
          }
          expect(verifyRebuildParity(s).divergences, at).toEqual([]);
        }
      }, 300_000);
    }
  });
});
