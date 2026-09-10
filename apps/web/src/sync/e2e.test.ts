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

function makeReplicaClient(app: Hono, token: string): { driver: SqlDriver; client: SyncClient } {
  const driver = makeReplicaDriver();
  const client = new SyncClient({ driver, transport: makeInProcessTransport(app, token) });
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
});
