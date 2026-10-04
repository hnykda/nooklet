/**
 * B-713: retiring, restoring and replacing a graph. The folder moves (`retire.ts`), and the running
 * server's side (`GraphRegistry#retire` behind `DELETE /graphs/<id>`): the cached handle and every
 * socket on the graph are closed before the folder moves, the graph 404s afterwards, and bringing
 * it back serves the same data, verified by replaying its op log.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { LIVE_CLOSE } from "@nooklet/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { createToken } from "../auth/tokens.js";
import { closeDb } from "../db.js";
import { graphInstanceId } from "../graph-identity.js";
import { createLiveWebSocketServer, openLiveSocketCount } from "../live-limits.js";
import { buildRegistry } from "../ops/index.js";
import { post } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";
import { createMultiGraphApp } from "./mount.js";
import { openGraph } from "./open-graph.js";
import { graphDbPath, graphDir } from "./paths.js";
import { createGraphForCommand, type GraphHandle, GraphRegistry } from "./registry.js";
import {
  GraphRetireError,
  listRetired,
  parseRetiredName,
  replaceGraph,
  retiredRootDir,
  retireGraph,
  retireTimestamp,
  unretireGraph,
} from "./retire.js";

const ROOT = "test-root-token";
const BASE = { timezone: "UTC", port: 0, mirror: { enabled: false } };
const NOW = new Date("2026-10-04T15:30:12.345Z");

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "nooklet-retire-test-"));
}

function tokenIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM token ORDER BY id")
      .all()
      .map((r) => String(r.id));
  } finally {
    db.close();
  }
}

describe("retire.ts: folders move, nothing is deleted", () => {
  it("names a retired graph <id>-<UTC timestamp> and parses it back", () => {
    expect(retireTimestamp(NOW)).toBe("20261004T153012Z");
    expect(parseRetiredName("work-notes-20261004T153012Z")).toEqual({
      id: "work-notes",
      retiredAt: "2026-10-04T15:30:12Z",
    });
    expect(parseRetiredName("work-20261004T153012Z-2")?.id).toBe("work");
    expect(parseRetiredName("not-retired")).toBeUndefined();
  });

  it("retire, list --retired, unretire: the same folder comes back", () => {
    const dir = dataDir();
    createGraphForCommand(dir, "work", BASE, "Work");
    const before = tokenIds(graphDbPath(dir, "work"));

    const r = retireGraph(dir, "work", { now: NOW });
    expect(r.retiredName).toBe("work-20261004T153012Z");
    expect(existsSync(graphDir(dir, "work"))).toBe(false);
    expect(existsSync(join(r.path, "graph.sqlite"))).toBe(true);
    expect(listRetired(dir)).toEqual([
      {
        name: "work-20261004T153012Z",
        id: "work",
        retiredAt: "2026-10-04T15:30:12Z",
        label: "Work",
        path: join(retiredRootDir(dir), "work-20261004T153012Z"),
      },
    ]);

    unretireGraph(dir, r.retiredName);
    expect(tokenIds(graphDbPath(dir, "work"))).toEqual(before);
    expect(listRetired(dir)).toEqual([]);
  });

  it("two retires of one id in the same second do not collide", () => {
    const dir = dataDir();
    createGraphForCommand(dir, "work", BASE);
    retireGraph(dir, "work", { now: NOW });
    createGraphForCommand(dir, "work", BASE);
    expect(retireGraph(dir, "work", { now: NOW }).retiredName).toBe("work-20261004T153012Z-2");
    expect(listRetired(dir).map((g) => g.id)).toEqual(["work", "work"]);
  });

  it("refuses default without force, an unknown graph, and an unretire over an existing graph", () => {
    const dir = dataDir();
    createGraphForCommand(dir, "work", BASE);
    expect(() => retireGraph(dir, "default")).toThrow(/without --force/);
    expect(existsSync(graphDir(dir, "default"))).toBe(true);
    expect(() => retireGraph(dir, "nope")).toThrow(GraphRetireError);

    const r = retireGraph(dir, "work", { now: NOW });
    createGraphForCommand(dir, "work", BASE);
    expect(() => unretireGraph(dir, r.retiredName)).toThrow(/already exists/);
    expect(() => unretireGraph(dir, "../graphs/work-20261004T153012Z")).toThrow(/no retired/);

    // --as restores it beside the new one, and its graph.json lists it under the new id.
    const back = unretireGraph(dir, r.retiredName, "work-old");
    expect(back.id).toBe("work-old");
    expect(JSON.parse(readFileSync(join(back.path, "graph.json"), "utf8")).id).toBe("work-old");
    expect(retireGraph(dir, "default", { force: true }).id).toBe("default");
  });

  it("replace: carries the old graph's tokens into the new one, keeps its label, retires the old", () => {
    const dir = dataDir();
    createGraphForCommand(dir, "work", BASE, "Work");
    // Tokens minted on the old graph, as paired phones would hold.
    const { ctx } = openGraph(dir, "work", BASE);
    createToken(ctx.driver, { label: "phone", scope: "write", canSync: true });
    createToken(ctx.driver, { label: "laptop", scope: "read" });
    closeDb(ctx.driver);
    const tokens = tokenIds(graphDbPath(dir, "work"));
    expect(tokens).toHaveLength(2);

    const scratch = dataDir();
    createGraphForCommand(scratch, "default", BASE);
    const r = replaceGraph(dir, "work", scratch, { now: NOW });
    expect(r.tokensCarried).toBe(2);
    expect(tokenIds(graphDbPath(dir, "work"))).toEqual(tokens);
    expect(tokenIds(join(r.retired.path, "graph.sqlite"))).toEqual(tokens);
    expect(r.retired.retiredName).toBe("work-20261004T153012Z");
    expect(
      JSON.parse(readFileSync(join(graphDir(dir, "work"), "graph.json"), "utf8")),
    ).toMatchObject({ id: "work", label: "Work" });
    // The scratch copy is left as it was.
    expect(existsSync(graphDbPath(scratch, "default"))).toBe(true);
  });
});

describe("GraphRegistry#retire behind DELETE /graphs/<id>", () => {
  let server: ServerType | undefined;
  let wss: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    wss?.close();
    wss = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function makeApp() {
    const dir = dataDir();
    const closed: string[] = [];
    const registry = new GraphRegistry(dir, {
      registry: buildRegistry(),
      baseConfig: BASE,
      onClose: (h: GraphHandle) => {
        closed.push(h.id);
      },
    });
    const app = createMultiGraphApp({ dataDir: dir, registry, rootToken: ROOT });
    return { dir, registry, app, closed };
  }

  async function listen(app: ReturnType<typeof createMultiGraphApp>): Promise<number> {
    const ws = createLiveWebSocketServer();
    wss = ws;
    return new Promise<number>((resolve) => {
      server = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: ws } },
        (info) => resolve(info.port),
      );
    });
  }

  function open(port: number, path: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  }

  function del(app: ReturnType<typeof createMultiGraphApp>, path: string, token?: string) {
    return app.request(path, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it("is root-token only: no token and a graph's own admin token both get 401", async () => {
    const { app } = makeApp();
    const created = await post(app, "/graphs", ROOT, { id: "work" });
    expect((await del(app, "/graphs/work")).status).toBe(401);
    expect((await del(app, "/graphs/work", created.json.token)).status).toBe(401);
    expect((await app.request("/g/work/healthz")).status).toBe(200);
  });

  it("closes the handle and every socket (4410), 404s afterwards, and unretire brings the data back intact", async () => {
    const { app, dir, registry, closed } = makeApp();
    const created = await post(app, "/graphs", ROOT, { id: "work", label: "Work" });
    const token = created.json.token as string;
    expect(
      (await post(app, "/g/work/api/v1/page.create", token, { name: "Kept", markdown: "- one" }))
        .status,
    ).toBe(200);
    const handle = (await registry.resolve("work")) as GraphHandle;
    const instance = graphInstanceId(handle.ctx.driver);

    const port = await listen(app);
    // One socket that said hello on /sync/live, one that never did on /ui/live: both must close.
    const synced = await open(port, "/g/work/sync/live");
    synced.send(JSON.stringify({ type: "hello", device_id: "aaaaaaaa", token }));
    const silent = await open(port, "/g/work/ui/live");
    // A socket on another graph must be left alone.
    const otherToken = (await post(app, "/graphs", ROOT, { id: "other" })).json.token as string;
    const bystander = await open(port, "/g/other/sync/live");
    bystander.send(JSON.stringify({ type: "hello", device_id: "bbbbbbbb", token: otherToken }));
    await new Promise((r) => setTimeout(r, 50));
    expect(openLiveSocketCount()).toBe(3);
    const syncedClosed = closeCode(synced);
    const silentClosed = closeCode(silent);

    const res = await del(app, "/graphs/work", ROOT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retired: string; restore: string; path: string };
    expect(body.retired).toMatch(/^work-\d{8}T\d{6}Z$/);
    expect(body.restore).toBe(`nooklet graph unretire ${body.retired}`);
    expect(await syncedClosed).toBe(LIVE_CLOSE.graphRetired);
    expect(await silentClosed).toBe(LIVE_CLOSE.graphRetired);
    // Released from the one registry the connection caps count (B-676 H4) at once.
    expect(openLiveSocketCount()).toBe(1);
    expect(bystander.readyState).toBe(WebSocket.OPEN);
    expect(closed).toEqual(["work"]);
    // The old handle's database is closed: nothing can keep writing to the moved file.
    expect(() => handle.ctx.driver.get("SELECT 1")).toThrow();
    expect(existsSync(join(dir, body.path, "graph.sqlite"))).toBe(true);

    expect((await app.request("/g/work/healthz")).status).toBe(404);
    expect((await post(app, "/g/work/api/v1/page.list", token, {})).status).toBe(404);
    expect(
      (
        (await (
          await app.request("/graphs", { headers: { authorization: `Bearer ${ROOT}` } })
        ).json()) as { graphs: { id: string }[] }
      ).graphs.map((g) => g.id),
    ).not.toContain("work");
    expect((await del(app, "/graphs/work", ROOT)).status).toBe(404);

    // Back, with no restart: same instance, same token, same page, op log replays clean.
    unretireGraph(dir, body.retired);
    const list = await post(app, "/g/work/api/v1/page.list", token, {});
    expect(list.status).toBe(200);
    expect(list.json.items.map((p: { name: string }) => p.name)).toContain("Kept");
    const back = (await registry.resolve("work")) as GraphHandle;
    expect(back).not.toBe(handle);
    expect(graphInstanceId(back.ctx.driver)).toBe(instance);
    expect(verifyRebuildParity(back.ctx.driver).ok).toBe(true);
  });

  it("refuses default with 409 unless ?force=true, and does not close it on a refusal", async () => {
    const { app, registry } = makeApp();
    await registry.create("default");
    const res = await del(app, "/graphs/default", ROOT);
    expect(res.status).toBe(409);
    expect((await app.request("/g/default/healthz")).status).toBe(200);
    const handle = (await registry.resolve("default")) as GraphHandle;
    expect(() => handle.ctx.driver.get("SELECT 1")).not.toThrow();
    expect((await del(app, "/graphs/default?force=true", ROOT)).status).toBe(200);
    expect((await app.request("/g/default/healthz")).status).toBe(404);
  });

  it("never serves a stale handle after a graph folder is swapped by hand underneath it", async () => {
    const { app, dir, registry } = makeApp();
    const a = await post(app, "/graphs", ROOT, { id: "work" });
    await post(app, "/g/work/api/v1/page.create", a.json.token, { name: "Old Graph Page" });
    const b = await post(app, "/graphs", ROOT, { id: "other" });
    await post(app, "/g/other/api/v1/page.create", b.json.token, { name: "New Graph Page" });
    const oldHandle = (await registry.resolve("work")) as GraphHandle;
    const otherHandle = (await registry.resolve("other")) as GraphHandle;
    // Fold the WAL so a by-hand copy of "other" carries its page.
    otherHandle.ctx.driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Moved aside by hand: the next request 404s instead of serving the moved file.
    renameSync(graphDir(dir, "work"), join(dir, "work-aside"));
    expect((await app.request("/g/work/healthz")).status).toBe(404);
    expect(() => oldHandle.ctx.driver.get("SELECT 1")).toThrow();

    // A different graph renamed into place: served at once, with no restart.
    cpSync(graphDir(dir, "other"), graphDir(dir, "work"), { recursive: true });
    const created = createToken((await registry.resolve("work"))?.ctx.driver as never, {
      label: "t",
      scope: "read",
    });
    const list = await post(app, "/g/work/api/v1/page.list", created.token, {});
    expect(list.json.items.map((p: { name: string }) => p.name)).toContain("New Graph Page");
    expect(list.json.items.map((p: { name: string }) => p.name)).not.toContain("Old Graph Page");
  });

  it("replace keeps a device's token working against the replacement", async () => {
    const { app, dir, registry } = makeApp();
    const a = await post(app, "/graphs", ROOT, { id: "work", label: "Work" });
    const token = a.json.token as string;
    const before = graphInstanceId(((await registry.resolve("work")) as GraphHandle).ctx.driver);
    await registry.retire("work").then((r) => unretireGraph(dir, r.retiredName)); // close cleanly

    const scratch = dataDir();
    createGraphForCommand(scratch, "default", BASE);
    // `replaceGraph` runs with the graph not open (the CLI refuses while a server runs).
    const r = replaceGraph(dir, "work", scratch);
    expect(r.tokensCarried).toBe(1);
    const res = await post(app, "/g/work/api/v1/page.list", token, {});
    expect(res.status).toBe(200);
    // A new instance: devices see the GraphMismatch screen (B-631/B-633) and re-sync.
    const after = graphInstanceId(((await registry.resolve("work")) as GraphHandle).ctx.driver);
    expect(after).not.toBe(before);
  });
});
